#!/usr/bin/env node
// tools/voice-say.mjs — «РОТ» KLAS (фаза Г1, plans/11): русский TTS Silero локально, офлайн, CPU.
// Единая точка харнесса; тяжёлая работа — в Python-сайдкаре tools/voice/silero_say.py (venv
// F:\KLAS\voice\venv, интервью 003 Q5: аудио/ML — Python).
//
// Использование:
//   node tools/voice-say.mjs "Привет, Криник!"                 → voice\out\say-<ts>.wav + тайминги
//   node tools/voice-say.mjs "текст" --out путь.wav            → свой путь
//   node tools/voice-say.mjs "текст" --voice baya --play       → голос и воспроизведение (динамики)
// Голоса Silero ru: aidar (деф., муж.), baya, kseniya, xenia, eugene, random.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const PY = 'F:\\KLAS\\voice\\venv\\Scripts\\python.exe';          // venv голосового тракта (вне git)
const SIDE = path.join(import.meta.dirname, 'voice', 'silero_say.py');
const OUT_DIR = 'F:\\KLAS\\voice\\out';                            // артефакты синтеза (вне git)

const args = process.argv.slice(2);
const text = args[0];
if (!text || text.startsWith('--')) { console.error('Использование: node tools/voice-say.mjs "текст" [--out f.wav] [--voice aidar] [--play]'); process.exit(1); }
const flag = (n) => { const i = args.indexOf(n); return i > 0 ? args[i + 1] : null; };
const out = flag('--out') ?? path.join(OUT_DIR, `say-${Date.now()}.wav`);
const voice = flag('--voice') ?? 'aidar';

if (!existsSync(PY)) { console.error(`Нет venv голосового тракта: ${PY} — см. plans/11`); process.exit(1); }

const r = spawnSync(PY, [SIDE, text, out, voice], { encoding: 'utf8', timeout: 600_000, windowsHide: true });
// Тайминги сайдкар печатает JSON-строками в stderr; последняя stage:done — итог
const lines = (r.stderr || '').trim().split(/\r?\n/).filter(Boolean);
for (const l of lines) {
  try { const j = JSON.parse(l); if (j.stage === 'download') console.log(`(скачиваю модель ${j.model}…)`); } catch { console.error(l); }
}
const done = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).find((j) => j.stage === 'done');
if (r.status !== 0 || !done) { console.error(`Сайдкар упал (code=${r.status}): ${(r.stderr || '').slice(-400)}`); process.exit(1); }

console.log(`Готово: ${done.out}`);
console.log(`модель ${done.model} · голос ${done.voice} · аудио ${done.audio_sec} с · загрузка модели ${done.t_model_load_sec} с · синтез ${done.t_synth_sec} с · RTF ${done.rtf} (<1 = быстрее реального времени)`);

if (args.includes('--play')) {
  // Воспроизведение штатным .NET-плеером Windows — без внешних зависимостей и без окна
  spawnSync('powershell', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${done.out}').PlaySync()`], { windowsHide: true });
}
