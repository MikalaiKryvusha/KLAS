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
 */
export async function runTurn({ tts, question, user, outDir, playFn, onText }) {
  const t0 = performance.now();
  const res = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${gatewayToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'openclaw/default',
      stream: true,
      user,
      messages: [{ role: 'user', content: `${VOICE_STYLE}\n${question}` }],
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

  const enqueue = (text) => {
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
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    for (const line of decoder.decode(chunk, { stream: true }).split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      const delta = evt.choices?.[0]?.delta?.content;
      if (!delta) continue;
      full += delta;
      buf += delta;
      for (;;) {
        const m = buf.match(SENTENCE_END);
        if (!m || m.index + m[0].length < MIN_CHUNK_CHARS) break;
        const cut = m.index + m[0].length;
        enqueue(buf.slice(0, cut).trim());
        buf = buf.slice(cut);
      }
    }
  }
  if (buf.trim()) enqueue(buf.trim());   // хвост без завершающей пунктуации
  const coreMs = performance.now() - t0;
  await playChain;

  return {
    reply: full.trim(),
    sentences,
    coreMs,
    ttfaMs: firstAudioAt === null ? null : firstAudioAt - t0,   // главная метрика (researches/12 §1)
    totalMs: performance.now() - t0,
  };
}
