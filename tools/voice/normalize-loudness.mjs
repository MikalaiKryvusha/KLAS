#!/usr/bin/env node
// tools/voice/normalize-loudness.mjs — привести громкость синтеза к ОДНОМУ уровню (EBU R128).
//
// Зачем существует
// ---------------
// Клон голоса копирует из эталона ВСЁ, включая уровень записи. Замер 2026-07-29 (пять эталонов,
// два движка) показал перенос ±1–2 дБ:
//
//   эталон Туапсе  −13.7 дБ → клон −12.6 / −14.9
//   эталон склейки −18.3 дБ → клон −16.7 / −17.2
//   эталон Ви      −23.0 дБ → клон −24.3 / −29.8   ← владелец услышал это как «голос хороший, но тихо»
//
// Два следствия, и оба требуют лечения именно здесь:
//   1. Громкость ассистента зависела бы от того, с какой записи склонирован голос. Недопустимо.
//   2. Пока уровни разные, человек на прослушивании сравнивает ГРОМКОСТЬ, а не голос. Любая
//      слепая дегустация начинается с выравнивания уровней — иначе громкое кажется лучше.
//
// Метод — двухпроходный `loudnorm` ffmpeg (измерить → применить), а не одиночный проход и не
// пиковая нормализация:
//   * пиковая нормализация (`volumedetect` + gain) равняет ПИКИ, а человек слышит СРЕДНЮЮ
//     громкость: два файла с равными пиками звучат по-разному громко;
//   * одиночный проход `loudnorm` работает динамически и «качает» уровень внутри фразы.
//
// Цель по умолчанию −16 LUFS: общепринятый уровень для речи (моно-подкаст/ассистент), с запасом
// по истинному пику −1.5 dBTP, чтобы mp3-кодирование не ушло в клиппинг.
//
// Использование:
//   node tools/voice/normalize-loudness.mjs <вход.wav|mp3> [ещё файлы...] --out <каталог> [--lufs -16]
//
// [TESTED: 2026-07-29 · 45 клонов пяти эталонов: разброс средней громкости −12.0…−29.8 дБ
// сведён к одному уровню; проверка — повторный volumedetect после прогона.]

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

const run = promisify(execFile);

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const lufsIdx = argv.indexOf('--lufs');
const OUT_DIR = outIdx >= 0 ? argv[outIdx + 1] : null;
const TARGET_LUFS = lufsIdx >= 0 ? Number(argv[lufsIdx + 1]) : -16;
const TRUE_PEAK = -1.5;            // dBTP: запас, чтобы mp3-кодек не клиппил
const LRA = 11;                    // разброс громкости, штатное значение loudnorm для речи

const files = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out' && argv[i - 1] !== '--lufs');

if (!files.length || !OUT_DIR) {
  console.error('Использование: node tools/voice/normalize-loudness.mjs <файлы...> --out <каталог> [--lufs -16]');
  process.exit(1);
}
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

// Проход 1: измерить. loudnorm печатает JSON в stderr — оттуда и забираем.
async function measure(file) {
  const args = ['-hide_banner', '-i', file,
    '-af', `loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK}:LRA=${LRA}:print_format=json`,
    '-f', 'null', '-'];
  const { stderr } = await run('ffmpeg', args, { maxBuffer: 1 << 24 }).catch((e) => ({ stderr: e.stderr ?? '' }));
  const m = stderr.match(/\{[\s\S]*?\}/);
  if (!m) throw new Error(`loudnorm не отдал измерение для ${file}`);
  return JSON.parse(m[0]);
}

// Проход 2: применить измеренное — линейная нормализация, без динамического «качания».
async function apply(file, stats, outPath) {
  const f = [
    `loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK}:LRA=${LRA}`,
    `measured_I=${stats.input_i}`,
    `measured_TP=${stats.input_tp}`,
    `measured_LRA=${stats.input_lra}`,
    `measured_thresh=${stats.input_thresh}`,
    `offset=${stats.target_offset}`,
    'linear=true',
  ].join(':');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
    '-af', f, '-codec:a', 'libmp3lame', '-q:a', '2', '-y', outPath], { maxBuffer: 1 << 24 });
}

let ok = 0;
for (const file of files) {
  const out = join(OUT_DIR, basename(file, extname(file)) + '.mp3');
  try {
    const stats = await measure(file);
    await apply(file, stats, out);
    console.log(`${basename(file).padEnd(34)} было ${String(stats.input_i).padStart(7)} LUFS → ${TARGET_LUFS} LUFS`);
    ok++;
  } catch (e) {
    console.error(`ОШИБКА ${file}: ${e.message}`);
  }
}
console.log(`=== выровнено ${ok} из ${files.length}, цель ${TARGET_LUFS} LUFS → ${OUT_DIR} ===`);
