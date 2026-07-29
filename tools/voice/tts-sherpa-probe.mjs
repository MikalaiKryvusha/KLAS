// tools/voice/tts-sherpa-probe.mjs — СТЕНД сравнения двух ртов на ОДНИХ фразах, в одном прогоне.
//
// Зачем. Владелец ограничил рантайм голоса (2026-07-29): «при инференсе голос должен быть ресурсо
// лёгким», GPU нельзя. Кандидат в новый рот — sherpa-onnx OfflineTts (Piper VITS на CPU), потому что
// сам движок УЖЕ развёрнут: на нём работают наши уши (`voice-hear.mjs`, npm sherpa-onnx-node).
// Прежде чем учить свой голос, надо доказать, что этот рантайм не хуже нынешнего Silero, — иначе вся
// схема из `researches/15` §5 рушится на первом же шаге.
//
// Почему стенд, а не сравнение с числом из документа: числа Silero (0.08–0.11 с) сняты в другой день
// на другой загрузке машины. Сравнивать надо ОДНИМИ фразами в ОДНОМ прогоне — иначе меряешь погоду.
//
// Запуск:
//   node tools/voice/tts-sherpa-probe.mjs            # оба движка, полный набор фраз
//   node tools/voice/tts-sherpa-probe.mjs --sherpa   # только кандидат (Silero не поднимать)
//
// Артефакты: F:\KLAS\voice\out\probe\ (вне git) — wav обоих движков, чтобы проверить их УШАМИ
// (`node tools/voice-hear.mjs <wav>`): метрика рядом с артефактом не заменяет проверки артефакта
// (EXP-0016).
// [TESTED: 2026-07-29 · прогон в окружении владельца (PYTHONIOENCODING снята): sherpa медиана синтеза
//  0.194 с / RTF 0.058 против Silero 0.206 с / 0.045; все пять фраз кандидата прочитаны ушами KLAS
//  верно; вскрыты два эффекта — Piper читает цифры сам, а латиницу произносит русскими фонемами]

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { TtsDaemon } from './tts-daemon.mjs';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const MODEL_DIR = 'F:\\KLAS\\voice\\models\\vits-piper-ru_RU-ruslan-medium';
const OUT_DIR = 'F:\\KLAS\\voice\\out\\probe';

// Фикстура намеренно РАЗНОФОРМЕННАЯ (EXP-0013: набор из «нормальных» фраз проверяет сам себя):
// короткая · длинная · с цифрами · с единицами · с латиницей · с пунктуацией и вопросом.
const PHRASES = [
  ['короткая',    'Привет, Криник.'],
  ['длинная',     'Сегодня в Минске около двадцати двух градусов Цельсия, ветер слабый, дождя не ожидается.'],
  ['цифры',       'Температура 20 градусов, скорость 115 килобайт в секунду.'],
  ['латиница',    'Эта технология называется machine learning, и она уже работает.'],
  ['вопрос',      'Как тебя зовут, и чем ты можешь помочь?'],
];

const onlySherpa = process.argv.includes('--sherpa');
mkdirSync(OUT_DIR, { recursive: true });

/** Поднять кандидата. numThreads=2 — консервативно: рот делит CPU с ядром и ушами, занимать все
 *  ядра ради красивого RTF нечестно (в бою столько не дадут). */
function makeSherpaTts() {
  return new sherpa.OfflineTts({
    model: {
      vits: {
        model: path.join(MODEL_DIR, 'ru_RU-ruslan-medium.onnx'),
        tokens: path.join(MODEL_DIR, 'tokens.txt'),
        dataDir: path.join(MODEL_DIR, 'espeak-ng-data'),
      },
      numThreads: 2,
      provider: 'cpu',
      debug: false,
    },
    maxNumSentences: 1,
  });
}

const rows = [];

// --- Кандидат: sherpa-onnx OfflineTts (Piper VITS, CPU) ---
const tLoad0 = performance.now();
const tts = makeSherpaTts();
const loadSec = (performance.now() - tLoad0) / 1000;
console.log(`[sherpa] модель загружена за ${loadSec.toFixed(2)} с (разово, рантайм резидентный)`);

for (const [tag, text] of PHRASES) {
  const t0 = performance.now();
  const audio = tts.generate({ text, sid: 0, speed: 1.0 });
  const synth = (performance.now() - t0) / 1000;
  const dur = audio.samples.length / audio.sampleRate;
  const out = path.join(OUT_DIR, `sherpa_${tag}.wav`);
  sherpa.writeWave(out, { samples: audio.samples, sampleRate: audio.sampleRate });
  rows.push({ engine: 'sherpa', tag, synth, audio: dur, rtf: synth / dur, out });
  console.log(`[sherpa] ${tag.padEnd(9)} синтез ${synth.toFixed(3)} с · звук ${dur.toFixed(2)} с · RTF ${(synth / dur).toFixed(3)}`);
}

// --- Нынешний рот: Silero через резидентный сайдкар (тот же, что в бою) ---
if (!onlySherpa) {
  const silero = new TtsDaemon({ voice: 'eugene' });
  const ready = await silero.ready();
  if (ready?.stage === 'encoding-broken') {
    console.error('[silero] канарейка кодировки красная — сравнение недостоверно, см. bugs/08');
  } else {
    for (const [tag, text] of PHRASES) {
      const out = path.join(OUT_DIR, `silero_${tag}.wav`);
      const t0 = performance.now();
      const r = await silero.say(text, out);
      const synth = (performance.now() - t0) / 1000;
      if (!r?.ok) { console.log(`[silero] ${tag.padEnd(9)} отказ: ${r?.reason}`); continue; }
      const dur = r.audio_sec ?? 0;
      rows.push({ engine: 'silero', tag, synth, audio: dur, rtf: dur ? synth / dur : 0, out });
      console.log(`[silero] ${tag.padEnd(9)} синтез ${synth.toFixed(3)} с · звук ${dur.toFixed(2)} с · RTF ${(dur ? synth / dur : 0).toFixed(3)}`);
    }
  }
  silero.stop();
}

// --- Итог: медианы, потому что одиночная фраза шумит ---
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[(s.length - 1) >> 1] : 0; };
console.log('\n=== ИТОГ (медиана по фразам) ===');
for (const engine of ['sherpa', 'silero']) {
  const r = rows.filter((x) => x.engine === engine);
  if (!r.length) continue;
  console.log(`${engine.padEnd(7)} синтез ${median(r.map((x) => x.synth)).toFixed(3)} с · RTF ${median(r.map((x) => x.rtf)).toFixed(3)} · фраз ${r.length}`);
}
console.log(`\nwav обоих движков: ${OUT_DIR} — слушать ушами: node tools/voice-hear.mjs <файл>`);
