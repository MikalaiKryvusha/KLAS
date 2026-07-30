// tools/voice/voice-casting.mjs — КАСТИНГ ГОЛОСА АССИСТЕНТА (заказ владельца 2026-07-29).
//
// Владелец: «Найдёшь сам красивые голоса в интернете? Не обязательно Вихрова — бренд-воис
// дворецкого» → «напиши тестовые текста: русское и английское, цифры, имена собственные, код,
// единицы измерения — дай им всем записать» → «что-то много файлов получилось. Склей их в один
// по кандидатам».
//
// Прежде чем что-то обучать (часы GPU и корпус) — надо услышать то, что УЖЕ есть: девять готовых
// русских голосов из двух движков, все локальные и офлайн. Оккам: сначала выбрать из имеющегося.
//
// Итог — ОДИН файл `casting.mp3`: кандидаты подряд, каждый объявляет СВОЙ НОМЕР и читает пять
// текстов. Номер, а не имя, — намеренно: так выбор остаётся СЛЕПЫМ (это же просил владелец в
// интервью 004 Q3 — «слепой A/B»), а расшифровка «номер → голос» лежит рядом в index.md с
// таймкодами. Хочешь слушать вслепую — не открывай указатель; хочешь знать — открой.
//
// ⚠️ Тексты подобраны так, чтобы ловить РАЗНИЦУ ДВИЖКОВ, а не только тембр (`researches/15`):
// Silero режет реплику ПО АЛФАВИТУ и отдаёт латиницу настоящей английской модели, а Piper читает
// латиницу русскими фонемами через espeak-ng. Сокращения (ГБ, °C, КБ/с) разворачивает НАШ слой
// нормализации у Silero, а у Piper их развернуть некому — это слышно в тексте 3.
//
// Запуск: node tools/voice/voice-casting.mjs
// Результат: F:\KLAS\voice\out\casting\casting.mp3 + index.md (сырые wav — в parts\)
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
const PARTS = path.join(OUT, 'parts');    // сырые куски — отдельно, чтобы в папке лежал ОДИН файл
mkdirSync(PARTS, { recursive: true });

const JOIN_SR = 24000;   // общая частота склейки: у Piper 22050, у Silero 48000 — иначе не склеить

// Пять текстов, каждый со своей задачей. Один и тот же набор у ВСЕХ голосов: иначе сравниваешь
// тексты, а не голоса.
const LINES = [
  ['1-подпись', 'Добрый вечер, Николай. Системы KLAS в порядке, я к вашим услугам.'],
  ['2-имена', 'Ядро Qwen три и шесть отвечает через llama.cpp, чат Open WebUI поднят, а база знаний Kiwix содержит русскую Википедию.'],
  ['3-цифры', 'Видеокарта RTX 5070 Ti заняла 11.4 ГБ из 16, температура 62 °C, скорость 115 КБ/с, до встречи осталось 15 минут.'],
  ['4-код', 'Выполните команду git commit -m "fix voice", затем npm run build. Функция f(x) = 2x при x от 1 до 5 вернёт 10.'],
  ['5-смесь', 'Эта технология называется machine learning, и она уже работает: Python-скрипт обучает модель, а результат сохраняется в файл model.onnx.'],
];

// ⛔ ВЫБЫЛИ ПО СЛОВУ ВЛАДЕЛЬЦА (не возвращать без его слова — это его вкус, а не наш недосмотр):
//   piper/denis    — «сразу убираем, отстой полный» (2026-07-29)
//   piper/dmitri   — «убираем, плохо» (2026-07-29)
//   piper/irina    — «убираем» (2026-07-29)
//   silero/kseniya — «убираем, не нравится» (2026-07-29)
// ✅ ПОНРАВИЛОСЬ ВЛАДЕЛЬЦУ: silero/baya — «сам её ру голос красив, нравится» (2026-07-29).
//    Кандидат в Joi; её английский пока звучит чужим голосом — это НЕ её дефект, см. ниже.
//
// ⚠️ ЧТО ВЛАДЕЛЕЦ УСЛЫШАЛ ПРО `aidar` и `baya` — «англ и ру произносит разными голосами». Это дефект
// НАСТРОЙКИ, а не голоса: в сайдкаре один фиксированный английский диктор `DEFAULT_VOICE_EN = en_23`,
// подобранный по F0 под `eugene` (93.8 Гц). Для `aidar` (125 Гц) он уже чужой, для `baya` (246 Гц,
// женский) — мужчина 94 Гц. Лечение известно и дешёво: подобрать английского диктора ПОД КАЖДЫЙ
// русский голос тем же перебором (`pitch-check.py --match`, приём из bugs/11).
//
// 🔎 Рисунок отсева: выбыли ТРИ голоса Piper из четырёх. Если владелец снимет и `ruslan`, это уже не
// вкус к отдельным дикторам, а вердикт ВСЕМУ движку — и тогда выбор рантайма (`researches/15` §5)
// придётся пересматривать, потому что лёгкий CPU-рантайм у нас именно на нём.
const PIPER = ['ruslan'];                              // ru_RU-*-medium (sherpa-onnx)
const SILERO = ['eugene', 'aidar', 'baya', 'xenia'];   // v5_ru (+ v3_en на латинице)

/** Медианный F0 автокорреляцией — без новых зависимостей. Окна 40 мс с шагом 20 мс, медиана по
 *  озвонченным окнам: одно число даёт объективную ось «ниже/выше» рядом с субъективным «красивее». */
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
    if (bestLag && best / energy > 0.3) out.push(sr / bestLag);   // у тона пик заметно выше энергии
  }
  if (!out.length) return NaN;
  out.sort((a, b) => a - b);
  return out[out.length >> 1];
}

/** Привести wav к общей частоте и вернуть сэмплы. Ресемплинг отдаём ffmpeg — это ровно та задача,
 *  ради которой он уже стоит в стеке (KISS, не пишем свой). */
function atCommonRate(wavIn) {
  const out = wavIn.replace(/\.wav$/, '.join.wav');
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wavIn, '-ar', String(JOIN_SR), '-ac', '1', out], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(`ffmpeg не привёл ${path.basename(wavIn)}: ${r.stderr?.trim()}`); return null; }
  return sherpa.readWave(out).samples;
}

// --- Движки: единый интерфейс say(text, wavPath) -> ok ------------------------------------------
function piperSay(voice) {
  const dir = path.join(MODELS, `vits-piper-ru_RU-${voice}-medium`);
  if (!existsSync(dir)) return null;
  const tts = new sherpa.OfflineTts({
    model: {
      vits: { model: path.join(dir, `ru_RU-${voice}-medium.onnx`), tokens: path.join(dir, 'tokens.txt'), dataDir: path.join(dir, 'espeak-ng-data') },
      numThreads: 2, provider: 'cpu', debug: false,
    },
    maxNumSentences: 1,
  });
  return { say: async (text, wav) => { const a = tts.generate({ text, sid: 0, speed: 1.0 }); sherpa.writeWave(wav, { samples: a.samples, sampleRate: a.sampleRate }); return true; }, stop: () => {} };
}

async function sileroSay(voice) {
  const tts = new TtsDaemon({ voice });
  const ready = await tts.ready();
  // `!== 'ready'`: мёртвый сайдкар попадал в кастинг «рабочим голосом» с нулём файлов (ревизия 2026-07-31)
  if (ready?.stage !== 'ready') { tts.stop(); return null; }
  return { say: async (text, wav) => Boolean((await tts.say(text, wav))?.ok), stop: () => tts.stop() };
}

// --- Проход 1: все тексты всеми голосами + замер F0 ----------------------------------------------
// Номера кандидатов присваиваются ПОСЛЕ сортировки, поэтому объявления синтезируются вторым
// проходом: иначе «Кандидат 3» достался бы тому, кто в итоге стоит седьмым.
const voices = [
  ...PIPER.map((v) => ({ kind: 'piper', voice: v })),
  ...SILERO.map((v) => ({ kind: 'silero', voice: v })),
];

for (const v of voices) {
  const eng = v.kind === 'piper' ? piperSay(v.voice) : await sileroSay(v.voice);
  if (!eng) { console.log(`${v.kind} ${v.voice}: движок недоступен — пропуск`); v.skip = true; continue; }
  v.files = [];
  for (const [tag, text] of LINES) {
    const wav = path.join(PARTS, `${v.kind}_${v.voice}_${tag}.wav`);
    if (await eng.say(text, wav)) v.files.push(wav); else console.log(`${v.kind} ${v.voice} ${tag}: отказ синтеза`);
  }
  eng.stop();
  if (v.files.length) { const w = sherpa.readWave(v.files[0]); v.f0 = medianF0(w.samples, w.sampleRate); }
  console.log(`${v.kind.padEnd(7)}${v.voice.padEnd(9)} ✅ F0 ${Number.isNaN(v.f0) ? '—' : v.f0?.toFixed(0)} Гц`);
}

// Порядок: снизу вверх по высоте голоса — мужские (Jarvis) идут первыми, женские (Joi) следом.
const ordered = voices.filter((v) => !v.skip && v.files?.length).sort((a, b) => (a.f0 || 999) - (b.f0 || 999));

// --- Проход 2: объявления с финальными номерами --------------------------------------------------
for (let i = 0; i < ordered.length; i++) {
  const v = ordered[i];
  v.idx = i + 1;
  const eng = v.kind === 'piper' ? piperSay(v.voice) : await sileroSay(v.voice);
  if (!eng) continue;
  const wav = path.join(PARTS, `${v.kind}_${v.voice}_0-номер.wav`);
  if (await eng.say(`Кандидат ${v.idx}.`, wav)) v.intro = wav;
  eng.stop();
}

// --- Склейка в ОДИН трек с таймкодами ------------------------------------------------------------
const gapShort = Math.round(JOIN_SR * 0.6);   // между фразами внутри кандидата
const gapLong = Math.round(JOIN_SR * 1.5);    // между кандидатами — слышно, что начался новый
const blocks = [];
for (const v of ordered) {
  const samples = [v.intro, ...v.files].filter(Boolean).map(atCommonRate).filter(Boolean);
  if (samples.length) blocks.push({ v, samples });
}

let total = 0;
for (const b of blocks) { for (const s of b.samples) total += s.length + gapShort; total += gapLong; }
const track = new Float32Array(total);
let at = 0;
for (const b of blocks) {
  b.at = at / JOIN_SR;
  for (const s of b.samples) { track.set(s, at); at += s.length + gapShort; }
  at += gapLong;
}

const bigWav = path.join(PARTS, 'casting.full.wav');
const mp3 = path.join(OUT, 'casting.mp3');
sherpa.writeWave(bigWav, { samples: track, sampleRate: JOIN_SR });
const enc = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', bigWav, '-codec:a', 'libmp3lame', '-q:a', '3', mp3], { encoding: 'utf8' });
if (enc.status !== 0) console.error(`ffmpeg не собрал mp3: ${enc.stderr?.trim()}`);

const hhmmss = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

console.log('\n=== ОДИН ФАЙЛ, кандидаты подряд (снизу вверх по высоте голоса) ===');
for (const b of blocks) console.log(`${String(b.v.idx).padStart(2)}  ${hhmmss(b.at)}  ${b.v.kind.padEnd(7)}${b.v.voice.padEnd(9)}${(Number.isNaN(b.v.f0) ? '—' : b.v.f0.toFixed(0)).padStart(5)} Гц`);
console.log(`\nфайл: ${mp3}  (${hhmmss(total / JOIN_SR)})`);

// --- Указатель для владельца ---------------------------------------------------------------------
const md = [
  '# Кастинг голоса ассистента — один файл, слушать подряд',
  '',
  `> **\`casting.mp3\`** — ${hhmmss(total / JOIN_SR)}. Кандидаты идут подряд, каждый называет свой номер`,
  '> и читает пять одинаковых текстов. Имена намеренно НЕ звучат: выбор слепой (интервью 004 Q3).',
  '> Не хочешь подсказок — не читай таблицу ниже, слушай и запомни понравившиеся НОМЕРА.',
  '',
  '## Таймкоды и расшифровка',
  '',
  '| № | время | движок | голос | F0, Гц | роль по тембру |',
  '|---|---|---|---|---|---|',
  ...blocks.map((b) => `| ${b.v.idx} | ${hhmmss(b.at)} | ${b.v.kind} | **${b.v.voice}** | ${Number.isNaN(b.v.f0) ? '—' : b.v.f0.toFixed(0)} | ${Number.isNaN(b.v.f0) ? '—' : (b.v.f0 < 165 ? 'Jarvis (муж.)' : 'Joi (жен.)')} |`),
  '',
  '## Что читает каждый кандидат',
  '',
  ...LINES.map(([tag, text]) => `**${tag}** — ${text}`),
  '',
  '## На что слушать',
  '',
  '1. **Тембр и характер** (текст 1) — годится ли голос дворецкому: спокойствие, достоинство, тепло.',
  '2. **Имена собственные** (текст 2) — `Qwen`, `llama.cpp`, `Open WebUI`, `Kiwix`: коверкают все, вопрос — насколько терпимо.',
  '3. **Цифры и единицы** (текст 3) — `11.4 ГБ`, `62 °C`, `115 КБ/с`.',
  '4. **Код** (текст 4) — `git commit -m "fix voice"`, `f(x) = 2x`: речь или каша.',
  '5. **⭐ Смесь языков** (текст 5) — `machine learning`, `Python`, `model.onnx`: **главное различие движков.**',
  '   Кандидаты на движке `silero` отдают латиницу НАСТОЯЩЕЙ английской модели — верное произношение,',
  '   но это ДРУГОЙ диктор. Кандидаты на `piper` читают её русскими фонемами одним голосом — один',
  '   диктор, но «машин лони». Развилка из `bugs/11`, решается только ушами.',
  '',
  '⚠️ F0 — объективная ось «ниже/выше», а не оценка красоты. Красоту судит только владелец.',
  '',
  '**Как ответить:** номера 1–2 на Jarvis и 1–2 на Joi. Либо «все не годятся» — тогда учим свой голос',
  'на открытом корпусе (`researches/15` §5; SOVA — CC-BY, «Dialogs» 2026 — OpenRAIL).',
].join('\n');
writeFileSync(path.join(OUT, 'index.md'), md, 'utf8');
console.log('указатель: index.md');
