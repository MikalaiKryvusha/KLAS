#!/usr/bin/env node
// tools/voice-talk.mjs — «СКЕЛЕТ РАЗГОВОРА» KLAS (фаза Г3, plans/13): живой голосовой диалог.
// Каскад: микрофон (push-to-talk) → УШИ (voice-hear, GigaAM) → ЯДРО (резидентный гейтвей OpenClaw,
// SSE-стриминг) → РОТ (резидентный Silero) → динамики. Всё локально, всё офлайн.
//
// АРХИТЕКТУРА ЛАТЕНТНОСТИ (переработано 2026-07-28 по researches/12; было 24.5 с на ход).
// Три приёма золотого стандарта, каждый оплачен замером:
//   1. Ядро РЕЗИДЕНТНОЕ. Раньше каждый ход запускал `openclaw agent --local` = инициализация агента
//      заново (8.4–10.6 с накладных). Теперь ход идёт HTTP-запросом на уже поднятый гейтвей.
//   2. Рот РЕЗИДЕНТНЫЙ. Раньше питон-сайдкар грузил модель Silero заново (2.2 с на фразу). Теперь
//      модель живёт в процессе: синтез фразы — 0.1 с.
//   3. Ответ СТРИМИТСЯ и режется по предложениям. Первое предложение синтезируется и звучит, пока
//      ядро договаривает остальные. Метрика — TTFA (время до первого звука), а не «всего».
//
// Использование:
//   node tools/voice-talk.mjs                     → push-to-talk: Enter — начать, Enter — закончить
//   node tools/voice-talk.mjs --wav вопрос.wav    → автономный прогон каскада из готового wav (харнесс)
//   node tools/voice-talk.mjs --text "вопрос"     → прогон без микрофона и без ушей (замер ядра+рта)
//   node tools/voice-talk.mjs --device "имя dshow-микрофона"   (дефолт — NVIDIA Broadcast)
//   node tools/voice-talk.mjs --no-play           → не проигрывать ответ (тихий тест)
//   node tools/voice-talk.mjs --voice baya        → голос Silero (дефолт eugene — выбор владельца)
// Выход из диалога: пустая реплика (сразу два Enter) или Ctrl+C.
//
// ⚠️ Требуется ПОДНЯТЫЙ гейтвей OpenClaw (`powershell -File tools\klas.ps1 -Action up`) с включённым
// эндпоинтом `gateway.http.endpoints.chatCompletions.enabled`. Без него скрипт честно скажет, что делать.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { TtsDaemon } from './voice/tts-daemon.mjs';

const HERE = import.meta.dirname;
const OUT_DIR = 'F:\\KLAS\\voice\\out';
const OPENCLAW_CFG = path.join(process.env.USERPROFILE, '.openclaw', 'openclaw.json');
const GATEWAY_URL = 'http://127.0.0.1:18789/v1/chat/completions';
const MIC_DEFAULT = 'Микрофон (NVIDIA Broadcast)';   // реальный мик владельца (шумодав NVIDIA)
// Установка голосового стиля — в каждом ходе (надёжнее для локальных моделей, чем один раз за сессию)
const VOICE_STYLE = '(Голосовой запрос. Ответь КРАТКО и разговорно, 1-3 предложения, без markdown, списков и кода.)';
// Нарезка по КОНЦУ ПРЕДЛОЖЕНИЯ (researches/12 §5): под-предложенческая резка по запятым даёт больше,
// но рвёт просодию русского синтеза, а наш стиль и так требует коротких фраз. Порог длины защищает
// от огрызков вроде «Да.» — их дешевле озвучить вместе со следующей фразой.
const SENTENCE_END = /[.!?…]["»)]?\s/;
const MIN_CHUNK_CHARS = 12;

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const wavArg = flag('--wav');
const textArg = flag('--text');
const device = flag('--device') ?? MIC_DEFAULT;
const voice = flag('--voice') ?? 'eugene';           // дефолт владельца (домашка 02)
const play = !args.includes('--no-play');
const sessionUser = `voice-${new Date().toISOString().slice(0, 10)}`;   // один день = одна беседа

const run = (cmd, a, timeout = 300_000) => spawnSync(cmd, a, { encoding: 'utf8', timeout, windowsHide: true });

// --- УШИ: распознавание (разовый запуск; 1.3–1.7 с, из них загрузка модели — кандидат на резидент) ---
function hear(wav) {
  const r = run('node', [path.join(HERE, 'voice-hear.mjs'), wav]);
  if (r.status !== 0) throw new Error(`УШИ упали: ${(r.stderr || '').slice(-200)}`);
  return r.stdout.trim();
}

// --- Воспроизведение: асинхронное, чтобы не блокировать чтение потока от ядра ---
function playWav(wav) {
  return new Promise((resolve) => {
    const p = spawn('powershell', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${wav}').PlaySync()`], { windowsHide: true });
    p.on('close', resolve);
  });
}

/** Токен гейтвея из конфига ядра (в git не попадает — конфиг живёт в профиле пользователя). */
function gatewayToken() {
  if (!existsSync(OPENCLAW_CFG)) throw new Error(`Нет конфига ядра: ${OPENCLAW_CFG}`);
  const token = JSON.parse(readFileSync(OPENCLAW_CFG, 'utf8')).gateway?.auth?.token;
  if (!token) throw new Error('В конфиге ядра нет gateway.auth.token');
  return token;
}

/**
 * ЯДРО + РОТ одной стадией: стримит ответ гейтвея и отдаёт готовые предложения в синтез немедленно.
 * onSentence(текст) вызывается на каждой законченной фразе; возвращает полный текст ответа.
 */
async function thinkAndSpeak(question, onSentence) {
  const res = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${gatewayToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'openclaw/default',
      stream: true,
      user: sessionUser,                     // держит контекст беседы на стороне ядра
      messages: [{ role: 'user', content: `${VOICE_STYLE}\n${question}` }],
    }),
  });
  if (!res.ok) throw new Error(`ЯДРО ответило HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

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
      // Отрезаем всё, что уже стало законченной фразой, и сразу отдаём в синтез
      for (;;) {
        const m = buf.match(SENTENCE_END);
        if (!m || m.index + m[0].length < MIN_CHUNK_CHARS) break;
        const cut = m.index + m[0].length;
        onSentence(buf.slice(0, cut).trim());
        buf = buf.slice(cut);
      }
    }
  }
  if (buf.trim()) onSentence(buf.trim());   // хвост без завершающей пунктуации
  return full.trim();
}

// --- один ход диалога: wav/текст → уши → ядро(стрим) → рот(поток) → динамики ---
async function turn(tts, { wav, text }) {
  const t0 = performance.now();
  let heard = text;
  if (!heard) {
    heard = hear(wav);
    if (!heard) { console.log('(тишина — ничего не распознано)'); return; }
  }
  const tHeard = performance.now();
  console.log(`\n🎤 Ты: ${heard}`);

  // Конвейер: синтез стартует на первой готовой фразе, воспроизведение идёт строго по порядку.
  // playChain держит порядок фраз; синтез при этом уже запущен параллельно (резидент — FIFO).
  let playChain = Promise.resolve();
  let firstAudioAt = null, spokenCount = 0, silentCount = 0;
  const onSentence = (sentence) => {
    const wavOut = path.join(OUT_DIR, `talk-reply-${Date.now()}-${spokenCount + silentCount}.wav`);
    const synth = tts.say(sentence, wavOut);
    playChain = playChain.then(async () => {
      const r = await synth;
      if (!r.ok) {
        if (r.reason === 'no-cyrillic') { silentCount++; console.log(`(не озвучено: «${sentence}» — нет русских букв, bugs/06)`); }
        else console.error(`РОТ споткнулся: ${r.error}`);
        return;
      }
      spokenCount++;
      if (firstAudioAt === null) firstAudioAt = performance.now();
      if (play) await playWav(wavOut);
    });
  };

  const reply = await thinkAndSpeak(heard, onSentence);
  const tCore = performance.now();
  console.log(`🤖 KLAS: ${reply}`);
  await playChain;
  const tEnd = performance.now();

  const s = (ms) => (ms / 1000).toFixed(1);
  // TTFA — главная метрика (researches/12 §1): сколько человек слушает ТИШИНУ до первого звука.
  const ttfa = firstAudioAt ? s(firstAudioAt - t0) : '—';
  console.log(`[тайминги] уши ${s(tHeard - t0)} с · ядро ${s(tCore - tHeard)} с · всего ${s(tEnd - t0)} с · ⚡TTFA ${ttfa} с (фраз озвучено ${spokenCount})`);
}

// --- main ---
console.log(`Голосовой диалог с KLAS (сессия ${sessionUser}, голос ${voice}${wavArg || textArg ? '' : `, микрофон: ${device}`}).`);
const tts = new TtsDaemon({ voice });
const ready = await tts.ready();               // прогрев РТА идёт параллельно ожиданию первой реплики
if (ready.stage === 'dead') { console.error('РОТ не запустился — см. venv F:\\KLAS\\voice\\venv (plans/11)'); process.exit(1); }

try {
  // Ранняя проверка ядра: лучше честная инструкция сразу, чем падение после первой реплики
  gatewayToken();
  const ping = await fetch('http://127.0.0.1:18789/health').catch(() => null);
  if (!ping?.ok) {
    console.error('ЯДРО недоступно: гейтвей OpenClaw не поднят.\nПодними стек: powershell -File F:\\KLAS\\tools\\klas.ps1 -Action up');
    process.exit(1);
  }

  if (wavArg || textArg) {
    await turn(tts, { wav: wavArg, text: textArg });      // автономный прогон (харнесс)
  } else {
    for (;;) {
      const wav = path.join(OUT_DIR, `talk-input-${Date.now()}.wav`);
      const sec = await recordPushToTalk(wav);
      if (sec < 0.6 || !existsSync(wav)) { rmSync(wav, { force: true }); console.log('Пустая реплика — выхожу. Пока!'); break; }
      try { await turn(tts, { wav }); } catch (e) { console.error(String(e.message || e)); }
      rmSync(wav, { force: true });
    }
  }
} finally {
  tts.stop();
}

// Запись микрофона push-to-talk: ffmpeg dshow 16 кГц моно, останов по Enter (шлём q в stdin ffmpeg)
async function recordPushToTalk(outWav) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  await ask('Enter — НАЧАТЬ запись (пустая реплика позже = выход)… ');
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'dshow',
    '-i', `audio=${device}`, '-ac', '1', '-ar', '16000', outWav], { windowsHide: true });
  const t0 = performance.now();
  await ask('ЗАПИСЬ ИДЁТ — Enter, чтобы ЗАКОНЧИТЬ… ');
  ff.stdin.write('q');   // штатная остановка ffmpeg — файл закрывается корректно
  await new Promise((res) => ff.on('close', res));
  rl.close();
  return (performance.now() - t0) / 1000;
}
