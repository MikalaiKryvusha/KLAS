// tools/voice/wakeword-corpus.mjs — ГЕНЕРАТОР ОБУЧАЮЩЕГО КОРПУСА слова-активатора (план 19, шаг 1).
//
// Зачем. Оба готовых пути к активатору закрыты замерами (`researches/16`): sherpa `KeywordSpotter`
// даёт потолок 3/6 на русском произношении, готовая `hey_jarvis_v0.1` — 0/10. Русские активаторы
// придётся ОБУЧАТЬ, а обучение начинается с корпуса: тысячи произношений слова разными голосами и
// темпами. Конвейер openWakeWord штатно генерирует его через `piper-sample-generator` — но тот
// работает только на Linux и тянет свои веса. У нас четыре русских голоса Piper УЖЕ лежат в
// `voice\models\vits-piper-ru_RU-*` и УЖЕ синтезируются движком `sherpa-onnx-node`, на котором
// работают наши уши. Значит корпус собирается нулём новых сущностей и целиком на процессоре —
// видеокарта остаётся владельцу (KISS + Оккам).
//
// Что делает: слово × 4 диктора × развёртка по темпу × обрамления → wav 16 кГц моно.
// Плюс НЕГАТИВЫ — без них замер бесполезен: детектор, срабатывающий всегда, «находит» слово со 100%
// точностью. В негативах намеренно стоят фонетические ловушки («джазовая», «джойстик», «сервис»).
//
// ⚠️ Пересэмплировка. Голоса Piper выдают 22050 Гц, а openWakeWord (melspectrogram.onnx) ждёт 16000.
// Берём ВСТРОЕННЫЙ `LinearResampler` того же движка, а не пишем свой ресемплер и не гоняем тысячи
// вызовов ffmpeg (PHILOSOPHY: сначала готовый путь платформы).
//
// ⚠️ Вывод ДЕТЕРМИНИРОВАН: никакого Math.random — корпус это полное декартово произведение, поэтому
// перегенерация даёт побайтово тот же результат, и diff работает как доказательство (AGENT_GUIDE →
// «канонический порядок»). Разнообразие даёт аугментация (шум + реверберация) на следующем шаге.
//
// Запуск:
//   node tools/voice/wakeword-corpus.mjs                      # «Джарвис», полный корпус
//   node tools/voice/wakeword-corpus.mjs --word Джой --slug joy
//   node tools/voice/wakeword-corpus.mjs --plan               # только посчитать, ничего не синтезировать
//
// [NOT-TESTED] — родился 2026-07-31, замер цены на CPU идёт следующим шагом.

import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const MODELS = 'F:\\KLAS\\voice\\models';
const CORPUS_ROOT = 'F:\\KLAS\\voice\\wakeword\\corpus';

// Целевая частота дискретизации openWakeWord. Их melspectrogram.onnx обучен на 16 кГц —
// подать 22050 значит подать модели другую акустику, и ошибка будет ТИХОЙ (никакого исключения).
const TARGET_SR = 16000;

// --- Дикторы -------------------------------------------------------------------------------------
// Все четыре русских голоса Piper, что лежат на диске: три мужских и один женский. Разнообразие
// дикторов — главный источник обобщения для детектора: он должен зажигаться на ЛЮБОМ голосе, а не
// заучивать один тембр. У каждого голоса num_speakers = 1 ⇒ sid всегда 0 (проверено в .onnx.json).
const VOICES = ['denis', 'dmitri', 'irina', 'ruslan'];

// --- Темпы ---------------------------------------------------------------------------------------
// Владелец зовёт ассистента по-разному: устало и медленно, на бегу и быстро. Коридор шире, чем в
// разговорной норме проекта (12–14 симв/с), намеренно: корпус должен покрыть края, а не середину.
const SPEEDS = [0.80, 0.90, 1.00, 1.10, 1.25];

// --- Обрамления ----------------------------------------------------------------------------------
// `{W}` подставляется словом. Три группы, и каждая учит своему:
//   1) слово отдельно, с разной пунктуацией — интонация утверждения/оклика/вопроса;
//   2) слово В НАЧАЛЕ фразы — так его и произносят в бою («Джарвис, включи музыку»);
//   3) слово ВНУТРИ и В КОНЦЕ фразы — коартикуляция с соседними словами, самый трудный случай.
// Обращение к ассистенту в середине предложения редкость, но именно оно даёт детектору примеры,
// на которых он иначе будет молчать.
const FRAMINGS = [
  // 1. отдельно
  '{W}.',
  '{W}!',
  '{W}?',
  '{W}...',
  'Эй, {W}.',
  'Ну, {W}!',
  'Слушай, {W}.',
  // 2. в начале фразы
  '{W}, какая сегодня погода?',
  '{W}, включи музыку.',
  '{W}, поставь таймер на десять минут.',
  '{W}, что там по новостям?',
  '{W}, выключи свет в комнате.',
  '{W}, напомни мне позвонить завтра.',
  '{W}, сколько сейчас времени?',
  // 3. внутри и в конце фразы
  'Скажи, {W}, ты меня слышишь?',
  'Подожди, {W}, я не договорил.',
  'Спасибо, {W}.',
  'Да ладно тебе, {W}.',
  'Я думаю, {W}, что это плохая идея.',
  'Хорошо, {W}, давай так и сделаем.',
];

// --- Негативы ------------------------------------------------------------------------------------
// Две породы, и обе обязательны.
// (а) ФОНЕТИЧЕСКИЕ ЛОВУШКИ — слова, звучащие почти как активатор. «Джойстик» содержит «джой»
//     ЦЕЛИКОМ и потому опаснее всего; «сервис» и «Дарвин» бьют по хвосту «-рвис» у «Джарвиса».
//     Без них корпус негативов состоит из непохожего, а детектор ошибается ровно на похожем.
// (б) ОБЫЧНАЯ РЕЧЬ — фон, на котором детектор обязан молчать часами (метрика сферы — ложные
//     срабатывания в час).
const NEGATIVES = [
  // (а) ловушки
  'Джазовая музыка и джем на завтрак.',
  'Он купил новый джойстик для приставки.',
  'Джойстик сломался, нужен другой.',
  'Джинсы висят на стуле.',
  'Сервис работает круглосуточно.',
  'Технический сервис закрыт до понедельника.',
  'Дарвин написал происхождение видов.',
  'Джон приехал вчера вечером.',
  'Мой друг живёт в соседнем доме.',
  'Твой ответ меня удивил.',
  'Джаз играл всю ночь.',
  'Джокер оказался в колоде лишним.',
  // (б) обычная речь
  'Какая сегодня погода в Минске?',
  'Сегодня около двадцати двух градусов, ветер слабый.',
  'Поставь чайник, пожалуйста.',
  'Завтра нужно встать пораньше.',
  'Я закончил работу и иду домой.',
  'Список покупок лежит на столе.',
  'Эта книга оказалась интереснее, чем я ожидал.',
  'Включи, пожалуйста, свет на кухне.',
];

// --- Разбор аргументов ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
}
const WORD = arg('word', 'Джарвис');
const SLUG = arg('slug', 'jarvis');          // латиницей: имя каталога и будущей .onnx-модели
const PLAN_ONLY = argv.includes('--plan');   // посчитать объём, не занимая процессор

// --- Синтез --------------------------------------------------------------------------------------
function makeTts(voice) {
  const dir = path.join(MODELS, `vits-piper-ru_RU-${voice}-medium`);
  return new sherpa.OfflineTts({
    model: {
      vits: {
        model: path.join(dir, `ru_RU-${voice}-medium.onnx`),
        tokens: path.join(dir, 'tokens.txt'),
        dataDir: path.join(dir, 'espeak-ng-data'),
      },
      // Голосов четыре, а ядер у Ryzen 5700G восемь: по 2 потока на голос, чтобы генерация
      // не отбирала машину целиком — владелец на ней работает.
      numThreads: 2, provider: 'cpu', debug: false,
    },
    maxNumSentences: 1,
  });
}

// Один ресемплер на клип: у него есть внутренний буфер, и переиспользование БЕЗ reset() склеило бы
// хвост предыдущего клипа с началом следующего. Это ровно тот тихий дефект, который не даёт ошибки.
function to16k(samples, sourceSr) {
  if (sourceSr === TARGET_SR) return samples;
  const r = new sherpa.LinearResampler(sourceSr, TARGET_SR);
  return r.flush(samples);   // flush = «это последний кусок», иначе хвост остаётся внутри
}

function synthesize(tts, text, speed, outPath) {
  const audio = tts.generate({ text, sid: 0, speed });
  const samples = to16k(audio.samples, audio.sampleRate);
  sherpa.writeWave(outPath, { samples, sampleRate: TARGET_SR });
  return samples.length / TARGET_SR;   // длительность в секундах — она же улика, что клип не пустой
}

// --- Главное -------------------------------------------------------------------------------------
const outDir = path.join(CORPUS_ROOT, SLUG);
const posDir = path.join(outDir, 'positive');
const negDir = path.join(outDir, 'negative');

const posCount = VOICES.length * SPEEDS.length * FRAMINGS.length;
const negCount = VOICES.length * NEGATIVES.length;

console.log(`СЛОВО: «${WORD}»  (каталог: ${SLUG})`);
console.log(`Дикторы: ${VOICES.join(', ')}  ·  темпы: ${SPEEDS.join(', ')}`);
console.log(`Положительных: ${VOICES.length} × ${SPEEDS.length} × ${FRAMINGS.length} = ${posCount}`);
console.log(`Отрицательных: ${VOICES.length} × ${NEGATIVES.length} = ${negCount}`);
console.log(`Всего клипов: ${posCount + negCount}`);
console.log(`Каталог: ${outDir}`);

if (PLAN_ONLY) {
  console.log('\n--plan: только подсчёт, синтеза не было.');
  process.exit(0);
}

// Каталог пересобирается с нуля: остатки прошлого прогона с другим словом или другими темпами —
// это молчаливое загрязнение корпуса, которое потом ищут в метриках обучения, а не на диске.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(posDir, { recursive: true });
mkdirSync(negDir, { recursive: true });

const t0 = Date.now();
const manifest = [];
let totalSeconds = 0;

for (const voice of VOICES) {
  const tv = Date.now();
  const tts = makeTts(voice);

  // положительные
  for (const speed of SPEEDS) {
    FRAMINGS.forEach((framing, fi) => {
      const text = framing.replace('{W}', WORD);
      const name = `pos__${voice}__s${String(speed).replace('.', '')}__f${String(fi).padStart(2, '0')}.wav`;
      const sec = synthesize(tts, text, speed, path.join(posDir, name));
      totalSeconds += sec;
      manifest.push({ file: `positive/${name}`, voice, speed, text, seconds: +sec.toFixed(3) });
    });
  }

  // отрицательные — на нормальном темпе: их задача дать фон и ловушки, а не покрыть края темпа
  NEGATIVES.forEach((text, ni) => {
    const name = `neg__${voice}__n${String(ni).padStart(2, '0')}.wav`;
    const sec = synthesize(tts, text, 1.0, path.join(negDir, name));
    totalSeconds += sec;
    manifest.push({ file: `negative/${name}`, voice, speed: 1.0, text, seconds: +sec.toFixed(3) });
  });

  console.log(`  ${voice}: готов за ${((Date.now() - tv) / 1000).toFixed(1)} с`);
}

// Манифест — источник правды о том, ЧТО именно синтезировано: без него корпус это папка безымянных
// wav, и следующая сессия не сможет ни воспроизвести его, ни объяснить метрику обучения.
manifest.sort((a, b) => a.file.localeCompare(b.file));   // детерминированный порядок
writeFileSync(
  path.join(outDir, 'manifest.json'),
  JSON.stringify({ word: WORD, slug: SLUG, sampleRate: TARGET_SR, voices: VOICES, speeds: SPEEDS, clips: manifest }, null, 2),
  'utf8',
);

const elapsed = (Date.now() - t0) / 1000;
console.log(`\nСинтезировано ${manifest.length} клипов · ${totalSeconds.toFixed(1)} с звука · за ${elapsed.toFixed(1)} с`);
console.log(`Скорость: ${(manifest.length / elapsed).toFixed(1)} клипов/с · RTF ${(elapsed / totalSeconds).toFixed(3)}`);

// --- ОХРАННИК ------------------------------------------------------------------------------------
// Класс EXP-0042: пять охранников проекта физически не могли покраснеть, и один из них считал пустоту
// успехом («0 строк = 0 проблем»). Здесь проверяется РОВНО то, чем корпус может тихо оказаться
// негодным: клипов меньше обещанного, или какой-то клип пуст/подозрительно короток.
const expected = posCount + negCount;
const tooShort = manifest.filter((c) => c.seconds < 0.20);
const problems = [];
if (manifest.length !== expected) problems.push(`клипов ${manifest.length}, а ожидалось ${expected}`);
if (tooShort.length) problems.push(`пустых или короче 0.20 с: ${tooShort.length} (${tooShort.slice(0, 3).map((c) => c.file).join(', ')}…)`);
if (totalSeconds <= 0) problems.push('суммарная длительность звука — ноль');

if (problems.length) {
  console.error('\n❌ ОХРАННИК КОРПУСА: ' + problems.join(' · '));
  process.exit(1);
}
console.log('✅ Охранник корпуса: клипов столько, сколько обещано, пустых нет.');
