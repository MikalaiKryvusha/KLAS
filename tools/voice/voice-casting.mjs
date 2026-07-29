// tools/voice/voice-casting.mjs — КАСТИНГ ГОЛОСА АССИСТЕНТА (заказ владельца 2026-07-29).
//
// Владелец: «Найдёшь сам красивые голоса в интернете? В опенсорсе должны быть красивые семплы.
// Не обязательно Вихрова — бренд-воис дворецкого» + «напиши тестовые текста, чтобы там было и
// русское и английское, и цифры, и имена собственные, и код, и единицы измерения — и дай им всем
// записать этот текст. я вечером послушаю mp3 шки».
//
// Прежде чем что-то обучать (часы GPU и корпус) — надо услышать то, что УЖЕ есть: девять готовых
// русских голосов из двух движков, все локальные и офлайн. Оккам: сначала выбрать из имеющегося.
//
// ⚠️ Тексты подобраны так, чтобы ловить РАЗНИЦУ ДВИЖКОВ, а не только тембр. Ключевое различие уже
// измерено (`researches/15`): Silero режет реплику ПО АЛФАВИТУ и отдаёт латиницу настоящей английской
// модели, а Piper читает латиницу русскими фонемами через espeak-ng («machine learning» → «машин
// лони»). Цифры Piper разворачивает сам, Silero — нашим слоем нормализации (bugs/13). Поэтому в
// текстах намеренно есть и латиница, и сырые цифры: владелец услышит не абстрактную «красоту»,
// а поведение конкретного тракта на своём материале.
//
// Выход: ОДИН mp3 на голос (все тексты подряд с паузами) — так голоса сравниваются подряд, а не
// щелчками по папке. Отдельные wav тоже остаются, если понадобится разбор.
//
// Запуск: node tools/voice/voice-casting.mjs
// Результат: F:\KLAS\voice\out\casting\ (вне git) + index.md
// Требует ffmpeg в PATH (тот же, что у голосового тракта).
// [NOT-TESTED]

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { TtsDaemon } from './tts-daemon.mjs';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const MODELS = 'F:\\KLAS\\voice\\models';
const OUT = 'F:\\KLAS\\voice\\out\\casting';
mkdirSync(OUT, { recursive: true });

// Пять текстов, каждый со своей задачей. Один и тот же набор у ВСЕХ голосов: иначе сравниваешь
// тексты, а не голоса.
const LINES = [
  ['1-подпись', 'Добрый вечер, Николай. Системы KLAS в порядке, я к вашим услугам.'],
  ['2-имена', 'Ядро Qwen три и шесть отвечает через llama.cpp, чат Open WebUI поднят, а база знаний Kiwix содержит русскую Википедию.'],
  ['3-цифры', 'Видеокарта RTX 5070 Ti заняла 11.4 ГБ из 16, температура 62 °C, скорость 115 КБ/с, до встречи осталось 15 минут.'],
  ['4-код', 'Выполните команду git commit -m "fix voice", затем npm run build. Функция f(x) = 2x при x от 1 до 5 вернёт 10.'],
  ['5-смесь', 'Эта технология называется machine learning, и она уже работает: Python-скрипт обучает модель, а результат сохраняется в файл model.onnx.'],
];

const PIPER = ['ruslan', 'denis', 'dmitri', 'irina'];           // ru_RU-*-medium (sherpa-onnx)
const SILERO = ['eugene', 'aidar', 'baya', 'kseniya', 'xenia']; // v5_ru (+ v3_en на латинице)

/** Медианный F0 автокорреляцией — без новых зависимостей (numpy/librosa не нужны).
 *  Окна 40 мс с шагом 20 мс, медиана по озвонченным окнам: одно число даёт объективную ось
 *  «ниже/выше» рядом с субъективным «красивее». */
function medianF0(samples, sr, fmin = 60, fmax = 320) {
  const win = Math.round(0.04 * sr), hop = Math.round(0.02 * sr);
  const lagMin = Math.floor(sr / fmax), lagMax = Math.floor(sr / fmin);
  const out = [];
  for (let start = 0; start + win < samples.length; start += hop) {
    let energy = 0;
    for (let i = 0; i < win; i++) energy += samples[start + i] ** 2;
    if (energy / win < 1e-4) continue;                 // тишина — не голос, в статистику не берём
    let bestLag = 0, best = 0;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let s = 0;
      for (let i = 0; i + lag < win; i++) s += samples[start + i] * samples[start + i + lag];
      if (s > best) { best = s; bestLag = lag; }
    }
    if (bestLag && best / energy > 0.3) out.push(sr / bestLag);   // у настоящего тона пик выше энергии
  }
  if (!out.length) return NaN;
  out.sort((a, b) => a - b);
  return out[out.length >> 1];
}

/** Склеить дорожки в одну с паузами и отдать mp3. Склейку делаем САМИ, а не `ffmpeg concat`:
 *  частота дискретизации у движков разная, а внутри одного голоса — одна, поэтому простая
 *  конкатенация массива надёжнее и не требует фильтров. */
function joinToMp3(parts, sr, mp3Path) {
  const gap = Math.round(sr * 0.7);                    // пауза между фразами, чтобы не сливались
  const total = parts.reduce((n, p) => n + p.length + gap, 0);
  const all = new Float32Array(total);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length + gap; }
  const wav = mp3Path.replace(/\.mp3$/, '.wav');
  sherpa.writeWave(wav, { samples: all, sampleRate: sr });
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-codec:a', 'libmp3lame', '-q:a', '3', mp3Path], { encoding: 'utf8' });
  if (r.status !== 0) console.error(`ffmpeg не смог собрать ${path.basename(mp3Path)}: ${r.stderr?.trim()}`);
  return r.status === 0;
}

const rows = [];

// --- Голоса Piper через sherpa-onnx (кандидат в рантайм, CPU) ---
for (const voice of PIPER) {
  const dir = path.join(MODELS, `vits-piper-ru_RU-${voice}-medium`);
  if (!existsSync(dir)) { console.log(`piper  ${voice.padEnd(8)} нет модели — пропуск`); continue; }
  const tts = new sherpa.OfflineTts({
    model: {
      vits: { model: path.join(dir, `ru_RU-${voice}-medium.onnx`), tokens: path.join(dir, 'tokens.txt'), dataDir: path.join(dir, 'espeak-ng-data') },
      numThreads: 2, provider: 'cpu', debug: false,
    },
    maxNumSentences: 1,
  });
  const parts = [];
  let sr = 22050, f0 = NaN;
  for (const [tag, text] of LINES) {
    const a = tts.generate({ text, sid: 0, speed: 1.0 });
    sr = a.sampleRate;
    sherpa.writeWave(path.join(OUT, `piper_${voice}_${tag}.wav`), { samples: a.samples, sampleRate: sr });
    parts.push(a.samples);
    if (tag.startsWith('1')) f0 = medianF0(a.samples, sr);
  }
  const mp3 = path.join(OUT, `piper_${voice}.mp3`);
  const ok = joinToMp3(parts, sr, mp3);
  rows.push({ engine: 'piper', voice, f0, mp3: ok ? path.basename(mp3) : '—' });
  console.log(`piper  ${voice.padEnd(8)} ✅ F0 ${Number.isNaN(f0) ? '—' : f0.toFixed(0)} Гц`);
}

// --- Голоса Silero через резидентный сайдкар (нынешний рот) ---
for (const voice of SILERO) {
  const tts = new TtsDaemon({ voice });
  const ready = await tts.ready();
  if (ready?.stage === 'encoding-broken') { console.error(`silero ${voice}: канарейка кодировки красная — пропуск`); tts.stop(); continue; }
  const parts = [];
  let sr = 48000, f0 = NaN;
  for (const [tag, text] of LINES) {
    const wav = path.join(OUT, `silero_${voice}_${tag}.wav`);
    const r = await tts.say(text, wav);
    if (!r?.ok) { console.log(`silero ${voice.padEnd(8)} ${tag}: отказ (${r?.reason})`); continue; }
    const w = sherpa.readWave(wav);
    sr = w.sampleRate;
    parts.push(w.samples);
    if (tag.startsWith('1')) f0 = medianF0(w.samples, sr);
  }
  tts.stop();
  const mp3 = path.join(OUT, `silero_${voice}.mp3`);
  const ok = parts.length ? joinToMp3(parts, sr, mp3) : false;
  rows.push({ engine: 'silero', voice, f0, mp3: ok ? path.basename(mp3) : '—' });
  console.log(`silero ${voice.padEnd(8)} ✅ F0 ${Number.isNaN(f0) ? '—' : f0.toFixed(0)} Гц`);
}

// --- Указатель для владельца ---
rows.sort((a, b) => (Number.isNaN(a.f0) ? 999 : a.f0) - (Number.isNaN(b.f0) ? 999 : b.f0));
console.log('\n=== КАСТИНГ (снизу вверх по высоте голоса) ===');
for (const r of rows) console.log(`${r.engine.padEnd(8)}${r.voice.padEnd(10)}${(Number.isNaN(r.f0) ? '—' : r.f0.toFixed(0)).padStart(6)} Гц   ${r.mp3}`);

const md = [
  '# Кастинг голоса ассистента — что слушать вечером',
  '',
  '> Собрано `node tools/voice/voice-casting.mjs`. **Один mp3 на голос**, внутри пять текстов подряд',
  '> с паузами. У всех голосов текст ОДИН И ТОТ ЖЕ — сравниваются голоса, а не тексты.',
  '',
  '## Кандидаты (снизу вверх по высоте голоса)',
  '',
  '| движок | голос | F0, Гц | роль по тембру | файл |',
  '|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.engine} | **${r.voice}** | ${Number.isNaN(r.f0) ? '—' : r.f0.toFixed(0)} | ${Number.isNaN(r.f0) ? '—' : (r.f0 < 165 ? 'Jarvis (муж.)' : 'Joi (жен.)')} | \`${r.mp3}\` |`),
  '',
  '## Что в каждом файле (пять текстов, каждый со своей задачей)',
  '',
  ...LINES.map(([tag, text]) => `**${tag}** — ${text}`),
  '',
  '## На что слушать',
  '',
  '1. **Тембр и характер** — текст 1. Годится ли этот голос дворецкому: спокойствие, достоинство, тепло.',
  '2. **Имена собственные** — текст 2 (`Qwen`, `llama.cpp`, `Open WebUI`, `Kiwix`): их коверкают все, вопрос — насколько терпимо.',
  '3. **Цифры и единицы** — текст 3 (`11.4 ГБ`, `62 °C`, `115 КБ/с`): дробные и сокращения — известная слабая точка.',
  '4. **Код** — текст 4 (`git commit -m "fix voice"`, `f(x) = 2x`): звучит ли это как речь или как каша.',
  '5. **⭐ Смесь языков** — текст 5 (`machine learning`, `Python`, `model.onnx`): **главное различие движков.**',
  '   `silero_*` отдаёт латиницу НАСТОЯЩЕЙ английской модели (другой диктор, но верное произношение);',
  '   `piper_*` читает её русскими фонемами одним голосом (один диктор, но «машин лони»).',
  '   Это ровно та развилка из `bugs/11`, которую можно решить только ушами.',
  '',
  '⚠️ F0 — объективная ось «ниже/выше», а не оценка красоты. Красоту судит только владелец.',
  '',
  '**Как ответить:** назвать 1–2 голоса для Jarvis и 1–2 для Joi, либо «все не годятся — учим свой»',
  '(тогда идём в обучение на открытом корпусе, см. `researches/15` §5).',
].join('\n');
writeFileSync(path.join(OUT, 'index.md'), md, 'utf8');
console.log(`\nпапка: ${OUT}\nуказатель: index.md`);
