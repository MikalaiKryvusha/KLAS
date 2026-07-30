#!/usr/bin/env node
// tools/voice/ref-scout.mjs — НАЙТИ в записи окна, пригодные под эталон клонирования.
//
// Зачем существует
// ---------------
// Эталон определяет у клона почти всё: тембр, ГРОМКОСТЬ и — главное — ТЕМП. У F5 длительность
// синтеза выводится буквально из пропорции эталона (`utils_infer.py:505`):
//     duration = ref_audio_len / ref_text_len * gen_text_len / speed
// то есть «символов в секунду» эталона и есть будущая скорость речи ассистента.
//
// Коридор владельца ИЗМЕРЕН на его же вердиктах (три независимых подтверждения, обе границы):
//     10.1 симв/с → «слишком медленно и томно, НЕПРИЕМЛИМО»
//     12.9 симв/с → «неплохо, самый приемлемый»
//     17.2 симв/с → «чуть слишком восторженно» / «тараторит»
// ⇒ цель ≈ 13 симв/с.
//
// ⛔ И отдельно: темп НЕЛЬЗЯ докручивать ручкой `speed`. Владелец услышал это дважды —
// «искусственно медленно говорит, это слышно» и «слышно искажение голоса машинерией».
// Значит нужный темп ВЫБИРАЕТСЯ ЭТАЛОНОМ. Ради этого выбора и написан инструмент.
//
// Что считает по каждому окну
//   * cps        — символов расшифровки на секунду (наш прокси темпа; здесь прокси И ЕСТЬ предмет)
//   * mean/max   — уровень: клон копирует громкость эталона (замер: −23 дБ эталон → −29 дБ клон)
//   * noise      — уровень В ПАУЗАХ, то есть шумовой порог. Он важен, потому что выравнивание
//                  громкости выхода поднимает шум вместе с голосом: владелец услышал это как «песок»
//   * границы    — окно всегда начинается и кончается НА ПАУЗЕ, чтобы эталон не резал слово
//
// Использование:
//   node tools/voice/ref-scout.mjs <файл> [--min 9] [--max 12] [--target 13] [--top 6]
//   --min/--max — длительность окна в секундах (по умолчанию 9…12: под порог обрезки F5 = 12 с)
//
// [NOT-TESTED] — маркер снимается после прогона на материале владельца.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const argv = process.argv.slice(2);
const num = (flag, def) => { const i = argv.indexOf(flag); return i >= 0 ? Number(argv[i + 1]) : def; };
const FILE = argv.find((a) => !a.startsWith('--') && !/^\d+(\.\d+)?$/.test(a));
const MIN_S = num('--min', 9);
const MAX_S = num('--max', 12);
const TARGET = num('--target', 13);
const TOP = num('--top', 6);

if (!FILE) {
  console.error('Использование: node tools/voice/ref-scout.mjs <файл> [--min 9] [--max 12] [--target 13] [--top 6]');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'refscout-'));

/** Границы пауз: silencedetect даёт начало/конец каждой тишины. */
async function findPauses(file) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', file,
    '-af', 'silencedetect=noise=-34dB:d=0.15', '-f', 'null', '-'],
    { maxBuffer: 1 << 26 }).catch((e) => ({ stderr: e.stderr ?? '' }));
  const pauses = [];
  let start = null;
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start:\s*([\d.]+)/);
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (s) start = Number(s[1]);
    if (e && start !== null) { pauses.push({ start, end: Number(e[1]) }); start = null; }
  }
  return pauses;
}

async function duration(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', file]);
  return Number(stdout.trim());
}

/** Средняя и пиковая громкость участка. */
async function volume(file, ss, t) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-ss', String(ss), '-t', String(t),
    '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    { maxBuffer: 1 << 24 }).catch((e) => ({ stderr: e.stderr ?? '' }));
  const mean = stderr.match(/mean_volume:\s*(-?[\d.]+)/);
  const max = stderr.match(/max_volume:\s*(-?[\d.]+)/);
  return { mean: mean ? Number(mean[1]) : NaN, max: max ? Number(max[1]) : NaN };
}

/** Расшифровка участка нашими же ушами — источник длины текста для cps. */
async function transcribe(file, ss, t, tag) {
  const wav = join(work, `${tag}.wav`);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-t', String(t),
    '-i', file, '-ac', '1', '-ar', '16000', '-y', wav]);
  // Читаем stdout ребёнка БАЙТАМИ и сами декодируем UTF-8. Ни cmd-редиректа, ни временного файла:
  // порча кодировки случается только когда байты проходят через шелл (bugs/08), а здесь их
  // никто не трогает.
  const hear = new URL('../voice-hear.mjs', import.meta.url).pathname.replace(/^\//, '');
  const { stdout } = await run(process.execPath, [hear, wav, '--model', 'punct'],
    { maxBuffer: 1 << 24, encoding: 'buffer' });
  return stdout.toString('utf8').trim();
}

const total = await duration(FILE);
const pauses = await findPauses(FILE);
// Точки, по которым можно резать: конец каждой паузы (речь начинается) и её начало (речь кончилась).
const cuts = [0, ...pauses.flatMap((p) => [p.end, p.start]), total].sort((a, b) => a - b);

// Шумовой порог: самая длинная пауза в записи — там слышен только фон.
const longest = pauses.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
const noise = longest ? await volume(FILE, longest.start + 0.05, Math.max(0.1, (longest.end - longest.start) - 0.1)) : { mean: NaN };

const cands = [];
for (let i = 0; i < cuts.length; i++) {
  for (let j = i + 1; j < cuts.length; j++) {
    const len = cuts[j] - cuts[i];
    if (len < MIN_S) continue;
    if (len > MAX_S) break;
    cands.push({ ss: cuts[i], len });
  }
}
if (!cands.length) {
  console.log(`Нет окон длиной ${MIN_S}–${MAX_S} с, начинающихся и кончающихся на паузе. Запись ${total.toFixed(1)} с, пауз ${pauses.length}.`);
  rmSync(work, { recursive: true, force: true });
  process.exit(0);
}

console.log(`Файл: ${FILE}`);
console.log(`Длительность ${total.toFixed(1)} с · пауз ${pauses.length} · шумовой порог ${noise.mean?.toFixed(1)} дБ`);
console.log(`Окон-кандидатов ${cands.length}, цель ${TARGET} симв/с, окно ${MIN_S}–${MAX_S} с\n`);

const rows = [];
let n = 0;
for (const c of cands) {
  const text = await transcribe(FILE, c.ss, c.len, `w${n++}`);
  const chars = text.length;
  if (!chars) continue;
  const cps = chars / c.len;
  const vol = await volume(FILE, c.ss, c.len);
  rows.push({ ...c, chars, cps, ...vol, snr: vol.mean - (noise.mean ?? -60), text });
}

rows.sort((a, b) => Math.abs(a.cps - TARGET) - Math.abs(b.cps - TARGET));
for (const r of rows.slice(0, TOP)) {
  const mm = String(Math.floor(r.ss / 60)).padStart(2, '0');
  const ss = (r.ss % 60).toFixed(2).padStart(5, '0');
  console.log(`${mm}:${ss} +${r.len.toFixed(2)} с · ${r.cps.toFixed(1)} симв/с · ` +
              `уровень ${r.mean.toFixed(1)} дБ (пик ${r.max.toFixed(1)}) · над шумом ${r.snr.toFixed(1)} дБ`);
  console.log(`    ${r.text.slice(0, 150)}`);
}
rmSync(work, { recursive: true, force: true });
