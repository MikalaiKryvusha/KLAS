// tools/voice/pipeline.mjs — ОБЩИЙ конвейер одного голосового хода (Г3, plans/13).
// Один и тот же код исполняют и живой диалог `tools/voice-talk.mjs`, и бенч `tools/voice-bench.mjs`.
// Это принципиально: бенч, проверяющий КОПИЮ конвейера, ничего не гарантирует про боевой путь.
//
// Ход: текст вопроса → ядро (резидентный гейтвей, SSE-стриминг) → нарезка по предложениям →
// резидентный синтез каждой фразы → воспроизведение по порядку.
//
// Воспроизведение внедряется параметром `playFn`, чтобы бенч мог подменить динамики на проверку
// (распознать файл, сверить его хеш до/после), сохранив ТЕ ЖЕ тайминги — иначе гонки не воспроизвести.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const OPENCLAW_CFG = path.join(process.env.USERPROFILE, '.openclaw', 'openclaw.json');
const GATEWAY_HEALTH = 'http://127.0.0.1:18789/health';
const GATEWAY_URL = 'http://127.0.0.1:18789/v1/chat/completions';

// Установка голосового стиля — в каждом ходе (надёжнее для локальных моделей, чем один раз за сессию).
// Требование владельца 2026-07-29: ответ пойдёт в ГОЛОС, поэтому числа и единицы измерения должны быть
// СЛОВАМИ — «20 C» и «115 кб/c» человеку на слух непонятны, а синтезу их не прочитать. Это лишь первый
// слой: локальная модель инструкцию иногда забывает, поэтому в резиденте есть детерминированный
// разворот единиц (tools/voice/silero_daemon.py) — он подстрахует.
// ⚠️ Пример «56 → пятьдесят шесть» обязателен: без него модель понимает «числа словами» как «цифры по
// одной» и отвечает «пять шесть» (поймано бенчем 2026-07-29).
export const VOICE_STYLE = '(Голосовой запрос — ответ будет ОЗВУЧЕН вслух. Ответь КРАТКО и разговорно, 1-3 предложения, без markdown, списков и кода. Числа пиши СЛОВАМИ целиком: 56 — это «пятьдесят шесть», а не «пять шесть». Единицы измерения — полными словами без сокращений: не «20 C», а «двадцать градусов Цельсия»; не «115 кб/c», а «сто пятнадцать килобайт в секунду». Иностранные термины и названия оставляй на языке оригинала, не переводи их.)';

// Нарезка по КОНЦУ ПРЕДЛОЖЕНИЯ (researches/12 §5). Порог длины защищает от огрызков вроде «Да.» —
// их дешевле озвучить вместе со следующей фразой, чем плодить микрофайлы.
const SENTENCE_END = /[.!?…]["»)]?\s/;
const MIN_CHUNK_CHARS = 12;

// РАЗМЕТКА ДИРЕКТИВЫ СИНТЕЗА ЯДРА (bugs/14). В конфиге ядра включён свой TTS-провайдер, и модель
// иногда оборачивает ответ в директиву `[[tts(text="…")]]`, отдавая её как обычный текст. Наш тракт
// синтезирует сам, поэтому директива ему не нужна ни в каком виде: без чистки владелец услышал бы
// «ти-ти-эс текст» перед ответом (латинский кусок `tts text` уходит в английскую модель).
// Снимаем ТОЛЬКО известную форму и одиночные двойные скобки — широкая чистка «всё в скобках» съела бы
// законный текст.
const CORE_MARKUP = [
  /\[\[\s*tts\s*\(\s*text\s*=\s*["'`]?/gi,   // открывающая половина директивы
  /["'`]?\s*\)\s*\]\]/g,                     // закрывающая половина
  /\[\[|\]\]/g,                              // осиротевшие скобки, если половины разъехались по фразам
];

/** Убрать разметку директивы ядра из фразы, оставив её текст (bugs/14). */
export function stripCoreMarkup(text) {
  let out = text;
  for (const re of CORE_MARKUP) out = out.replace(re, '');
  return out.trim();
}

/**
 * Смещение первой границы предложения, дающей кусок НЕ КОРОЧЕ порога; -1, если такой ещё нет.
 *
 * ⚠️ Читается «первая ПОДХОДЯЩАЯ», а не «первая вообще» — и в этом весь bugs/09. Прежний код брал
 * `buf.match(SENTENCE_END)` (то есть самое РАННЕЕ совпадение) и выходил из цикла, если оно короче
 * порога. На ответе вроде «Привет! У меня пока нет имени. Давай выберем…» самой ранней границей
 * навсегда оставался «Привет!» (8 символов < 12), порог не преодолевался НИ НА ОДНОЙ итерации, более
 * поздние границы не рассматривались вовсе — и весь ответ уезжал одним куском хвостом. Стриминг,
 * ради которого нарезка и существует, молча обнулялся: TTFA становился равен полному ответу.
 * Экспортируется, чтобы охранник в tools/voice-bench.mjs проверял нарезку детерминированно,
 * не завися от того, что именно сегодня ответит модель.
 */
export function firstSentenceCut(text) {
  const re = new RegExp(SENTENCE_END.source, 'g');
  for (let m; (m = re.exec(text)); ) {
    const cut = m.index + m[0].length;
    if (cut >= MIN_CHUNK_CHARS) return cut;
  }
  return -1;
}

/** Токен гейтвея из конфига ядра (вне git — живёт в профиле пользователя). */
export function gatewayToken() {
  if (!existsSync(OPENCLAW_CFG)) throw new Error(`Нет конфига ядра: ${OPENCLAW_CFG}`);
  const token = JSON.parse(readFileSync(OPENCLAW_CFG, 'utf8')).gateway?.auth?.token;
  if (!token) throw new Error('В конфиге ядра нет gateway.auth.token');
  return token;
}

/** Поднят ли гейтвей: без него голосового тракта нет вовсе (researches/12 §5, риск лечения). */
export async function gatewayAlive() {
  const r = await fetch(GATEWAY_HEALTH).catch(() => null);
  return Boolean(r?.ok);
}

/**
 * Один ход. Возвращает {reply, sentences[], coreMs, ttfaMs, totalMs}.
 * @param {object}   o
 * @param {TtsDaemon} o.tts      резидентный рот
 * @param {string}   o.question  текст реплики человека
 * @param {string}   o.user      ключ сессии беседы на стороне ядра (контекст держит ядро)
 * @param {string}   o.outDir    куда писать wav фраз
 * @param {Function} o.playFn    (wav, meta) => Promise — воспроизведение; бенч подменяет проверкой
 * @param {Function} [o.onText]  колбэк на каждую готовую фразу (для печати в чат)
 * @param {string}   [o.style]   префикс хода; дефолт — голосовой стиль. Диспетчер активаторов
 *   (`tools/voice-wake.mjs`) подставляет сюда «промпт персоны + голосовой стиль»: имя, которым
 *   позвали, выбирает не только голос, но и характер (идея 05). Префикс идёт В КАЖДОМ ходе по той же
 *   причине, что и сам VOICE_STYLE, — локальная модель забывает роль, заданную один раз за сессию.
 */
export async function runTurn({ tts, question, user, outDir, playFn, onText, style = VOICE_STYLE }) {
  const t0 = performance.now();
  const res = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${gatewayToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'openclaw/default',
      stream: true,
      user,
      messages: [{ role: 'user', content: `${style}\n${question}` }],
    }),
  });
  if (!res.ok) throw new Error(`ЯДРО ответило HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const sentences = [];
  let playChain = Promise.resolve();
  let firstAudioAt = null;
  // ⚠️ Счётчик ФРАЗ, а не озвученных: имя файла обязано быть уникальным в момент ПОСТАНОВКИ В ОЧЕРЕДЬ.
  // Дефект 2026-07-28: имя строилось из Date.now() и счётчика, растущего в цепочке ВОСПРОИЗВЕДЕНИЯ, —
  // фразы одного всплеска дельт резались в одну миллисекунду, получали ОДНО имя, и синтез следующей
  // затирал файл, который в этот момент играл → в динамиках шум вместо речи (владелец услышал
  // «сррс рсрср срр»). Уникальность здесь — охранник этого класса; его проверяет tools/voice-bench.mjs.
  let queued = 0;

  const enqueue = (raw) => {
    // Чистим ДО постановки в очередь: дальше строка идёт и в синтез, и в отчёт человеку (bugs/14)
    const text = stripCoreMarkup(raw);
    if (!text) return;                       // от фразы осталась одна разметка — произносить нечего
    const index = queued++;
    const wav = path.join(outDir, `talk-reply-${index}-${Date.now()}.wav`);
    const item = { index, text, wav, ok: false, reason: null };
    sentences.push(item);
    onText?.(item);
    const synth = tts.say(text, wav);
    playChain = playChain.then(async () => {
      const r = await synth;
      item.ok = Boolean(r.ok);
      item.reason = r.reason ?? r.error ?? null;
      item.audioSec = r.audio_sec ?? null;
      item.spoken = r.spoken ?? item.text;   // что РЕАЛЬНО произнесено (цифры → слова): по нему судят звук
      item.langs = r.langs ?? null;
      if (!item.ok) return;
      if (firstAudioAt === null) firstAudioAt = performance.now();
      await playFn(wav, item);
    });
  };

  let full = '', buf = '';
  // Причина завершения хода из SSE. Нужна охранникам бенча: непустой текст НЕ доказывает, что ход
  // состоялся (bugs/12 — гейтвей отдавал строку-заглушку, и все проверки оставались зелёными).
  // Забирать ОБЯЗАТЕЛЬНО до `if (!delta) continue`: финальный чанк несёт finish_reason при ПУСТОЙ
  // дельте, поэтому проверка на контент выбросила бы ровно то событие, ради которого всё делается.
  let finishReason = null;
  const decoder = new TextDecoder();
  const handleLine = (line) => {
    if (!line.startsWith('data: ')) return;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') return;
    let evt;
    try { evt = JSON.parse(payload); } catch { return; }
    const fr = evt.choices?.[0]?.finish_reason;
    if (fr) finishReason = fr;
    const delta = evt.choices?.[0]?.delta?.content;
    if (!delta) return;
    full += delta;
    buf += delta;
    for (;;) {
      const cut = firstSentenceCut(buf);
      if (cut === -1) break;
      enqueue(buf.slice(0, cut).trim());
      buf = buf.slice(cut);
    }
  };
  // Хвост, не завершённый '\n', живёт МЕЖДУ чанками. TextDecoder(stream) чинит только разрезанные
  // БАЙТЫ utf-8; СТРОКУ `data: {...}`, разрезанную границей чанка, прежний код терял молча: первая
  // половина — битый JSON в catch, вторая не начинается с 'data: ' — дельта (или финальный
  // finish_reason) выпадали из речи без следа (ревизия 2026-07-31). [NOT-TESTED]
  let sse = '';
  try {
    for await (const chunk of res.body) {
      sse += decoder.decode(chunk, { stream: true });
      const lines = sse.split('\n');
      sse = lines.pop();                 // недорезанная строка ждёт следующего чанка
      for (const line of lines) handleLine(line);
    }
  } catch (e) {
    // Обрыв стрима (смерть гейтвея, bugs/15) не должен оставлять плавающий playChain: уже
    // поставленные фразы иначе доигрывают в фоне ПОВЕРХ следующего кейса бенча.
    await playChain.catch(() => {});
    throw e;
  }
  sse += decoder.decode();
  if (sse) handleLine(sse);
  if (buf.trim()) enqueue(buf.trim());   // хвост без завершающей пунктуации
  const coreMs = performance.now() - t0;
  await playChain;

  return {
    // Человеку — очищенный текст (иначе он ВИДИТ в чате разметку, которой не слышит, — bugs/14).
    // Охранникам — сырой: если чистить и его, детектор машинной разметки в бенче ослепнет и дефект
    // ядра снова станет невидимым. Один источник, две роли, ни одна не подменяет другую.
    reply: stripCoreMarkup(full.trim()),
    rawReply: full.trim(),
    // null = ядро не прислало причину вовсе (тоже сведение, а не «всё хорошо»): охранник обязан
    // различать «ход завершился штатно», «ход оборвался» и «не знаю» — см. bugs/12.
    finishReason,
    sentences,
    coreMs,
    ttfaMs: firstAudioAt === null ? null : firstAudioAt - t0,   // главная метрика (researches/12 §1)
    totalMs: performance.now() - t0,
  };
}
