// tools/voice/multi-vs-current.mjs — сравнение ГОТОВОГО двуязычного решения с нынешним трактом.
//
// Вопрос владельца: «неужели нет готового решения, модели, которая сразу два языка умеет?»
// Ответ найден: у Silero есть `multi_v2` — одна модель, один диктор, оба языка (проверено ушами:
// «Эта технология называется Machine larning…» — латиница распознана как латиница, значит
// произнесена по-английски, а не русскими фонемами).
//
// Этот стенд даёт владельцу услышать ЦЕНУ готового решения на одном тексте:
//   A. multi_v2 — ОДИН голос на оба языка, но потолок 16 кГц и дикторы поколения v2;
//   B. наш нынешний тракт v5_ru + v3_en — 48 кГц и одобренные голоса, но ДВА разных диктора.
// Файлы multi_* синтезирует python-стенд (`multi-probe`), здесь собирается сторона B и общий mp3.
//
// Запуск: node tools/voice/multi-vs-current.mjs
// [NOT-TESTED]

import { createRequire } from 'node:module';
import { mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { TtsDaemon } from './tts-daemon.mjs';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const OUT = 'F:\\KLAS\\voice\\out\\multi';
const JOIN_SR = 24000;
mkdirSync(OUT, { recursive: true });

const TEXTS = [
  ['mix', 'Эта технология называется machine learning, и она уже работает: Python-скрипт обучает модель.'],
  ['ru', 'Добрый вечер, Николай. Системы KLAS в порядке, я к вашим услугам.'],
];

// Порядок блоков в итоговом файле. Сначала готовое решение, следом наше нынешнее на том же тексте —
// так разница слышна подряд, а не по памяти.
const BLOCKS = [
  { label: 'multi_v2 baya', files: ['m16_baya_mix.wav', 'm16_baya_ru.wav'] },
  { label: 'наш v5 baya (два диктора)', silero: 'baya' },
  { label: 'multi_v2 aidar', files: ['m16_aidar_mix.wav', 'm16_aidar_ru.wav'] },
  { label: 'наш v5 eugene (два диктора)', silero: 'eugene' },
];

function atCommonRate(wavIn) {
  const out = wavIn.replace(/\.wav$/, '.join.wav');
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wavIn, '-ar', String(JOIN_SR), '-ac', '1', out], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(`ffmpeg: ${r.stderr?.trim()}`); return null; }
  return sherpa.readWave(out).samples;
}

// Сторона B — наш нынешний тракт, как он звучит в бою (резка по алфавиту, два диктора)
for (const b of BLOCKS.filter((x) => x.silero)) {
  const tts = new TtsDaemon({ voice: b.silero });
  // См. контракт ready(): 'encoding-broken' — синтез «работает», но выдаёт мусор в прослушку (ревизия 2026-07-31)
  const rdy = await tts.ready();
  if (rdy?.stage !== 'ready') { console.error(`РОТ не готов (${rdy?.stage}) — сторона B пропущена`); tts.stop(); continue; }
  b.files = [];
  for (const [tag, text] of TEXTS) {
    const f = `cur_${b.silero}_${tag}.wav`;
    const r = await tts.say(text, path.join(OUT, f));
    if (r?.ok) b.files.push(f);
  }
  tts.stop();
  console.log(`наш тракт ${b.silero}: ${b.files.length} файлов`);
}

// Склейка
const gapShort = Math.round(JOIN_SR * 0.5);
const gapLong = Math.round(JOIN_SR * 1.5);
const chunks = [];
let total = 0;
for (const b of BLOCKS) {
  b.samples = b.files.map((f) => path.join(OUT, f)).filter(existsSync).map(atCommonRate).filter(Boolean);
  b.at = total / JOIN_SR;
  for (const s of b.samples) total += s.length + gapShort;
  total += gapLong;
}
const track = new Float32Array(total);
let at = 0;
for (const b of BLOCKS) {
  b.at = at / JOIN_SR;
  for (const s of b.samples) { track.set(s, at); at += s.length + gapShort; }
  at += gapLong;
}
const wav = path.join(OUT, 'sravnenie.wav');
const mp3 = path.join(OUT, 'sravnenie.mp3');
sherpa.writeWave(wav, { samples: track, sampleRate: JOIN_SR });
spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-codec:a', 'libmp3lame', '-q:a', '3', mp3], { encoding: 'utf8' });

const hhmmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`;
console.log('\n=== ЧТО В ФАЙЛЕ ===');
for (const b of BLOCKS) console.log(`${hhmmss(b.at)}  ${b.label}`);
console.log(`\n${mp3}  (${hhmmss(total / JOIN_SR)})`);
