// tools/voice/compare-ways.mjs — ЧЕТЫРЕ СПОСОБА произнести двуязычную фразу, одним файлом.
//
// Заказ владельца 2026-07-29: услышать в сравнении, чем платит каждый путь к «одному голосу».
// Собирается один mp3 с проговорёнными подписями — сверяться с таймкодами на слух неудобно.
//
// Способы (порядок — от самого дешёвого к самому дорогому):
//   1. Латиница КАК ЕСТЬ в русской модели — контроль: показывает, что английское молча ИСЧЕЗАЕТ.
//   2. Транслитерация английского кириллицей — идея владельца; один голос, 48 кГц, ноль новых моделей.
//   3. Нынешний тракт (v5_ru + v3_en по алфавиту) — верное произношение, но ДВА разных диктора.
//   4. multi_v2 — одна модель на оба языка, но потолок 16 кГц и дикторы поколения v2.
//
// Подписи наговаривает тот же `eugene`, чтобы не вносить в сравнение чужой тембр.
// Запуск: node tools/voice/compare-ways.mjs
// [NOT-TESTED]

import { createRequire } from 'node:module';
import { mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { TtsDaemon } from './tts-daemon.mjs';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const OUT = 'F:\\KLAS\\voice\\out\\sravnenie';
const V55 = 'F:\\KLAS\\voice\\out\\v55';
const MULTI = 'F:\\KLAS\\voice\\out\\multi';
const JOIN_SR = 24000;
mkdirSync(OUT, { recursive: true });

const PY = 'F:\\KLAS\\voice\\venv\\Scripts\\python.exe';

/** Синтез свежей моделью v5_5_ru (в тракте её ещё нет — зовём напрямую питоном). */
function v55(text, outWav, speaker = 'eugene') {
  const code = [
    'import torch, wave, sys',
    "m = torch.package.PackageImporter(r'F:\\\\KLAS\\\\voice\\\\models\\\\v5_5_ru.pt').load_pickle('tts_models','model')",
    "m.to(torch.device('cpu'))",
    `a = m.apply_tts(text=sys.argv[1], speaker='${speaker}', sample_rate=48000)`,
    "pcm = (a.clamp(-1,1)*32767).to(torch.int16).numpy().tobytes()",
    "w = wave.open(sys.argv[2],'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000); w.writeframes(pcm); w.close()",
  ].join('\n');
  const r = spawnSync(PY, ['-c', code, text, outWav], { encoding: 'utf8' });
  if (r.status !== 0) console.error(`v5_5 не синтезировал «${text.slice(0, 30)}…»: ${(r.stderr || '').slice(-200)}`);
  return r.status === 0;
}

function atCommonRate(wavIn) {
  const out = wavIn.replace(/\.wav$/, '.join.wav');
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wavIn, '-ar', String(JOIN_SR), '-ac', '1', out], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(`ffmpeg: ${r.stderr?.trim()}`); return null; }
  return sherpa.readWave(out).samples;
}

const FRASE_LAT = 'Эта технология называется machine learning, и она уже работает: Python-скрипт обучает модель.';
const FRASE_TRANSLIT = 'Эта технология называется мащин лёрнинг, и она уже работает: пайтон-скрипт обучает модель.';

// Готовим недостающие куски
console.log('синтезирую подписи и способы…');
const parts = [];
const add = (f) => { if (existsSync(f)) parts.push(f); else console.error(`нет файла ${f}`); };

const say = (text, name) => { const f = path.join(OUT, name); return v55(text, f) ? f : null; };

const l1 = say('Способ первый. Латиница как есть.', 'lbl1.wav');
const w1 = say(FRASE_LAT, 'way1_latin.wav');
const l2 = say('Способ второй. Английское записано кириллицей.', 'lbl2.wav');
const w2 = say(FRASE_TRANSLIT, 'way2_translit.wav');
const l3 = say('Способ третий. Нынешний тракт, два разных голоса.', 'lbl3.wav');
const l4 = say('Способ четвёртый. Мультиязычная модель, шестнадцать килогерц.', 'lbl4.wav');

// Способ 3 — наш боевой тракт как есть
const tts = new TtsDaemon({ voice: 'eugene' });
await tts.ready();
const w3 = path.join(OUT, 'way3_current.wav');
const r3 = await tts.say(FRASE_LAT, w3);
tts.stop();
if (!r3?.ok) console.error('нынешний тракт не синтезировал:', r3?.reason);

// Способ 4 — уже синтезирован python-стендом (multi_v2, 16 кГц)
const w4 = path.join(MULTI, 'm16_aidar_mix.wav');

for (const f of [l1, w1, l2, w2, l3, w3, l4, w4]) if (f) add(f);

// Склейка с паузами
const gap = Math.round(JOIN_SR * 0.8);
const samples = parts.map(atCommonRate).filter(Boolean);
const total = samples.reduce((n, s) => n + s.length + gap, 0);
const track = new Float32Array(total);
let at = 0;
for (const s of samples) { track.set(s, at); at += s.length + gap; }

const wav = path.join(OUT, 'sravnenie.wav');
const mp3 = path.join(OUT, 'sravnenie.mp3');
sherpa.writeWave(wav, { samples: track, sampleRate: JOIN_SR });
const enc = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-codec:a', 'libmp3lame', '-q:a', '3', mp3], { encoding: 'utf8' });
console.log(enc.status === 0 ? `\nГОТОВО: ${mp3}  (${(total / JOIN_SR).toFixed(0)} с)` : `ffmpeg упал: ${enc.stderr}`);
