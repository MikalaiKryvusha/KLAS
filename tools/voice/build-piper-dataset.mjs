#!/usr/bin/env node
// tools/voice/build-piper-dataset.mjs — собрать обучающий корпус для Piper VITS из длинной записи.
//
// Зачем
// -----
// Владелец 2026-07-30 выбрал голоса и попросил обучить ЛЁГКИЙ голос: «обучить лёгкий голос
// Piper VITS — давай тоже сделаем и послушаем». Это его же архитектура из `ideas/05_Jarvis.md`:
// тяжёлое считается ОДИН РАЗ офлайн на GPU, а в разговоре крутится маленький `.onnx` на CPU.
// Практическая цена вопроса измерена: с основной моделью в VRAM свободно ~950 МБ, а клон-движкам
// нужно 3150 МБ — они не уживаются. Обученный Piper занимает ноль VRAM и снимает конфликт.
//
// Что требует Piper (docs/TRAINING.md, прочитано 2026-07-30)
//   * каталог аудиофайлов;
//   * `metadata.csv` с разделителем `|`: `имя_файла|текст`. Текст фонемизируется espeak-ng;
//   * дообучение от готового чекпойнта — «highly recommended», ускоряет обучение кратно.
//
// Что делает этот инструмент
//   1. режет длинную запись ПО ПАУЗАМ на реплики 2–12 с (границы фраз, не по словам);
//   2. пишет их в 22 050 Гц моно — родная частота medium-моделей Piper;
//   3. расшифровывает каждую НАШИМИ ушами (GigaAM `punct`) и собирает `metadata.csv`;
//   4. отбраковывает пустые, слишком тихие и подозрительно быстрые/медленные куски.
//
// ⚠️ Честная граница: расшифровка машинная, ошибки в неё попадут. Промышленная практика такая же
// (обычно Whisper), и на тысячах реплик несколько процентов ошибок терпимы — но это НЕ то же
// самое, что выверенный вручную корпус, и в отчёте это надо называть, а не умалчивать.
//
// Использование:
//   node tools/voice/build-piper-dataset.mjs <исходник.mp3> <каталог> [--min 2] [--max 12] [--limit N]
//
// [NOT-TESTED] — маркер снимается после прогона и проверки metadata.csv глазами.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
// Расшифровка ушей идёт в CSV, который Piper читает питоновским csv.reader с ДЕФОЛТНЫМ
// quotechar `"`. Кавычка в начале текста открывает закавыченное поле и склеивает строки файла
// в одну реплику — молча, до самого OOM на матрице внимания (bugs/18).
import { sanitizeText, verifyMetadata } from './piper-dataset-guard.mjs';

const run = promisify(execFile);
const argv = process.argv.slice(2);
const num = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? Number(argv[i + 1]) : d; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const [SRC, OUT] = positional;
const MIN_S = num('--min', 2);
const MAX_S = num('--max', 12);
const LIMIT = num('--limit', Infinity);
const SR = 22050;                 // родная частота medium-моделей Piper
const MIN_CHARS = 8;              // короче — расшифровке верить нельзя
const CPS_LO = 6, CPS_HI = 24;    // за этими границами почти всегда битая расшифровка, а не речь

if (!SRC || !OUT) {
  console.error('Использование: node tools/voice/build-piper-dataset.mjs <исходник> <каталог> [--min 2] [--max 12] [--limit N]');
  process.exit(1);
}

const WAVS = join(OUT, 'wav');
mkdirSync(WAVS, { recursive: true });

/** Границы пауз. Порог -34 дБ и 0.25 с подобраны на записи Вихрова: режет по фразам, не по словам. */
async function pauses(file) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', file,
    '-af', 'silencedetect=noise=-34dB:d=0.25', '-f', 'null', '-'],
    { maxBuffer: 1 << 28 }).catch((e) => ({ stderr: e.stderr ?? '' }));
  const out = [];
  let s = null;
  for (const line of stderr.split('\n')) {
    const a = line.match(/silence_start:\s*([\d.]+)/);
    const b = line.match(/silence_end:\s*([\d.]+)/);
    if (a) s = Number(a[1]);
    if (b && s !== null) { out.push({ start: s, end: Number(b[1]) }); s = null; }
  }
  return out;
}

async function duration(f) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]);
  return Number(stdout.trim());
}

async function hear(wav) {
  const tmp = wav.replace(/\.wav$/, '.16k.wav');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', wav, '-ac', '1', '-ar', '16000', '-y', tmp]);
  const hearJs = 'F:\\KLAS\\tools\\voice-hear.mjs';
  const { stdout } = await run(process.execPath, [hearJs, tmp, '--model', 'punct'],
    { maxBuffer: 1 << 24, encoding: 'buffer' });
  rmSync(tmp, { force: true });
  return stdout.toString('utf8').trim();
}

const total = await duration(SRC);
const ps = await pauses(SRC);
console.log(`исходник ${total.toFixed(0)} с, пауз ${ps.length}`);

// Реплика = отрезок речи между двумя паузами. Слишком длинные пропускаем: Piper учат на коротком.
const segments = [];
let prevEnd = 0;
for (const p of ps) {
  const len = p.start - prevEnd;
  if (len >= MIN_S && len <= MAX_S) segments.push({ ss: prevEnd, len });
  prevEnd = p.end;
}
console.log(`отрезков ${MIN_S}–${MAX_S} с: ${segments.length}`);

const rows = [];
let n = 0, skipped = 0;
for (const seg of segments.slice(0, LIMIT)) {
  const name = `utt_${String(n).padStart(5, '0')}.wav`;
  const path = join(WAVS, name);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(seg.ss), '-t', String(seg.len),
    '-i', SRC, '-ac', '1', '-ar', String(SR), '-y', path]);
  // sanitizeText снимает символы, специальные для csv.reader (`"`, `|`, перевод строки).
  // Уши с моделью `punct` умеют выдавать прямые кавычки — именно так родился bugs/18.
  const text = sanitizeText(await hear(path));
  const cps = text.length / seg.len;
  if (text.length < MIN_CHARS || cps < CPS_LO || cps > CPS_HI) {
    rmSync(path, { force: true });
    skipped++;
    continue;
  }
  rows.push(`${name}|${text}`);
  n++;
  if (n % 100 === 0) console.log(`  ...${n} реплик готово (отбраковано ${skipped})`);
}

const csvPath = join(OUT, 'metadata.csv');
writeFileSync(csvPath, rows.join('\n') + '\n', 'utf8');

// Охранник на выходе: корпус, который Piper разберёт НЕ так, как мы записали, лучше поймать
// здесь, чем через час обучения в виде «CUDA out of memory» (bugs/18).
const check = verifyMetadata(csvPath);
if (!check.ok) {
  console.error(`\n⛔ КОРПУС НЕ ПРОШЁЛ ОХРАННИКА: проблем ${check.problems.length}`);
  for (const p of check.problems) console.error(`   строка ${p.row} · ${p.kind} · ${p.line.slice(0, 100)}`);
  process.exit(1);
}
console.log(`\nохранник корпуса: ${check.rows} строк, проблем 0`);

const totalSec = segments.slice(0, LIMIT).reduce((a, s) => a + s.len, 0);
console.log(`\nГОТОВО: ${rows.length} реплик, отбраковано ${skipped}`);
console.log(`общая длительность корпуса ≈ ${(totalSec / 60).toFixed(1)} мин`);
console.log(`metadata.csv → ${join(OUT, 'metadata.csv')}`);
