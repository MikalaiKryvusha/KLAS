#!/usr/bin/env node
// tools/voice-talk.mjs — «СКЕЛЕТ РАЗГОВОРА» KLAS (фаза Г3, plans/13): живой голосовой диалог.
// Каскад: микрофон (push-to-talk) → УШИ (voice-hear, GigaAM) → ЯДРО (резидентный гейтвей OpenClaw,
// SSE-стриминг) → РОТ (резидентный Silero) → динамики. Всё локально, всё офлайн.
//
// Сам конвейер хода живёт в tools/voice/pipeline.mjs — ТОТ ЖЕ код исполняет бенч
// `node tools/voice-bench.mjs`, поэтому бенч проверяет боевой путь, а не свою копию.
//
// АРХИТЕКТУРА ЛАТЕНТНОСТИ (переработано 2026-07-28 по researches/12; было 24.5 с на ход):
// ядро резидентное (HTTP к поднятому гейтвею вместо запуска CLI каждый ход, −8.4…10.6 с) ·
// рот резидентный (модель Silero живёт в процессе, синтез фразы 3.7 → 0.1 с) ·
// ответ стримится и режется по предложениям. Метрика — TTFA (время до первого звука).
//
// Использование:
//   node tools/voice-talk.mjs                     → push-to-talk: Enter — начать, Enter — закончить
//   node tools/voice-talk.mjs --wav вопрос.wav    → прогон каскада из готового wav (без микрофона)
//   node tools/voice-talk.mjs --text "вопрос"     → прогон без микрофона и ушей (замер ядра+рта)
//   node tools/voice-talk.mjs --device "имя dshow-микрофона"   (дефолт — NVIDIA Broadcast)
//   node tools/voice-talk.mjs --no-play           → не проигрывать ответ (тихий тест)
//   node tools/voice-talk.mjs --voice baya        → голос Silero (дефолт eugene — выбор владельца)
//   node tools/voice-talk.mjs --ears punct        → УШИ с пунктуацией и латиницей (bugs/10);
//        дефолт `ru` — нынешняя модель, лучший чистый русский, но без запятых и без латиницы
//   node tools/voice-talk.mjs --voice-en en_46    → английский диктор для латиницы (дефолт en_23,
//        подобран измерением под eugene — bugs/11; кандидаты рядом: en_46, en_112)
// Выход из диалога: пустая реплика (сразу два Enter) или Ctrl+C.
//
// ⚠️ Требуется ПОДНЯТЫЙ гейтвей OpenClaw (`powershell -File tools\klas.ps1 -Action up`).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { TtsDaemon } from './voice/tts-daemon.mjs';
import { gatewayAlive, gatewayToken, runTurn } from './voice/pipeline.mjs';
import { acquireVoiceSession } from './voice/single-instance.mjs';

const HERE = import.meta.dirname;
const OUT_DIR = 'F:\\KLAS\\voice\\out';
const MIC_DEFAULT = 'Микрофон (NVIDIA Broadcast)';   // реальный мик владельца (шумодав NVIDIA)

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const wavArg = flag('--wav');
const textArg = flag('--text');
const device = flag('--device') ?? MIC_DEFAULT;
const voice = flag('--voice') ?? 'eugene';           // дефолт владельца (домашка 02)
// Английский диктор: дефолт живёт в сайдкаре (подобран измерением под `eugene`, bugs/11).
// Флаг существует, чтобы владелец мог сравнить кандидатов УШАМИ, не трогая код: en_23 · en_46 · en_112.
const voiceEn = flag('--voice-en');
// Модель УШЕЙ (bugs/10). `ru` — нынешняя (34 токена: только строчная кириллица, SOTA по чистому
// русскому). `punct` — тот же GigaAM-v3, но 257 токенов: пунктуация, заглавные, «ё» и ЛАТИНИЦА.
// Дефолт пока `ru`: смена модели ушей — элемент стека, то есть решение владельца, а замер на
// синтезированной фикстуре дал смешанный результат (см. bugs/10). Владелец судит своим микрофоном.
const ears = flag('--ears') ?? 'ru';
const play = !args.includes('--no-play');
const sessionUser = `voice-${new Date().toISOString().slice(0, 10)}`;   // один день = одна беседа

// --- УШИ: распознавание (разовый запуск; 1.3–1.7 с — резидент кандидат на Г4) ---
function hear(wav) {
  const r = spawnSync('node', [path.join(HERE, 'voice-hear.mjs'), wav, '--model', ears], { encoding: 'utf8', timeout: 300_000, windowsHide: true });
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

// Запись микрофона push-to-talk: ffmpeg dshow 16 кГц моно, останов по Enter (шлём q в stdin ffmpeg)
async function recordPushToTalk(outWav) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  await ask('Enter — НАЧАТЬ запись (пустая реплика позже = выход)… ');
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'dshow',
    '-i', `audio=${device}`, '-ac', '1', '-ar', '16000', outWav], { windowsHide: true });
  // Обвязка ffmpeg (ревизия 2026-07-31): 'error' без слушателя РОНЯЛ весь диалог при отсутствии
  // ffmpeg; подписка на 'close' ПОСЛЕ остановки висла навсегда, если ffmpeg умер сразу (занятый
  // микрофон); stderr никто не читал — причина отказа устройства была невидима человеку.
  let ffErr = '';
  ff.stderr?.on('data', (d) => { ffErr += d; });
  ff.on('error', (e) => { ffErr += `\nspawn: ${e.message}`; });   // после 'error' Node всё равно эмитит 'close'
  ff.stdin?.on('error', () => { /* EPIPE в окно смерти ffmpeg — причина уже в ffErr */ });
  const closed = new Promise((res) => ff.on('close', res));      // подписка ДО остановки
  const t0 = performance.now();
  await ask('ЗАПИСЬ ИДЁТ — Enter, чтобы ЗАКОНЧИТЬ… ');
  try { ff.stdin.write('q'); } catch { /* уже мёртв */ }         // штатная остановка ffmpeg
  await closed;
  rl.close();
  if (ffErr.trim()) console.error(`ffmpeg: ${ffErr.trim().slice(0, 400)}`);
  return (performance.now() - t0) / 1000;
}

// --- один ход диалога ---
async function turn(tts, { wav, text }) {
  const tMic = performance.now();
  let heard = text;
  if (!heard) {
    heard = hear(wav);
    if (!heard) { console.log('(тишина — ничего не распознано)'); return; }
  }
  const earsMs = performance.now() - tMic;
  console.log(`\n🎤 Ты: ${heard}`);

  const r = await runTurn({
    tts, question: heard, user: sessionUser, outDir: OUT_DIR,
    playFn: play ? playWav : async () => {},
  });
  console.log(`🤖 KLAS: ${r.reply}`);
  for (const s of r.sentences.filter((x) => !x.ok)) {
    // Имя причины должно совпадать с тем, что РЕАЛЬНО присылает сайдкар (`nothing-to-say`).
    // Пока здесь стояло устаревшее `no-cyrillic`, штатный случай «произносить нечего» уходил в
    // ветку ошибки и выглядел поломкой тракта.
    if (s.reason === 'nothing-to-say') console.log(`(не озвучено: «${s.text}» — ни букв, ни цифр, bugs/06)`);
    else console.error(`РОТ споткнулся на «${s.text}»: ${s.reason}`);
  }

  const sec = (ms) => (ms / 1000).toFixed(1);
  const ttfa = r.ttfaMs === null ? '—' : sec(earsMs + r.ttfaMs);
  console.log(`[тайминги] уши ${sec(earsMs)} с · ядро ${sec(r.coreMs)} с · всего ${sec(earsMs + r.totalMs)} с · ⚡TTFA ${ttfa} с (озвучено фраз ${r.sentences.filter((x) => x.ok).length}/${r.sentences.length})`);
}

// --- main ---
// Динамики — один на всех: две говорящие сессии дают неразборчивую кашу, неотличимую от поломки
// звука (расследование 2026-07-28). Замок не даёт этому повториться.
if (play) {
  const lock = acquireVoiceSession('voice-talk');
  if (!lock.ok) {
    console.error(`Уже идёт голосовая сессия: ${lock.holder.who} (pid ${lock.holder.pid}, с ${lock.holder.at}).`);
    console.error('Две сессии говорят в одни колонки — на слух это каша. Закончи ту или запусти с --no-play.');
    process.exit(1);
  }
}

console.log(`Голосовой диалог с KLAS (сессия ${sessionUser}, голос ${voice}${wavArg || textArg ? '' : `, микрофон: ${device}`}).`);
const tts = new TtsDaemon({ voice, voiceEn });
const ready = await tts.ready();               // прогрев РТА идёт параллельно ожиданию первой реплики
if (ready.stage === 'dead') { console.error('РОТ не запустился — см. venv F:\\KLAS\\voice\\venv (plans/11)'); process.exit(1); }
// Сломанная кодировка НЕ мешает синтезу — она делает его бессмысленным (bugs/08). Лучше честный
// отказ на старте, чем полный диалог бормотания, который человек будет слушать и не понимать.
if (ready.stage === 'encoding-broken') {
  console.error('РОТ отвечает в неверной кодировке — речь была бы моджибейком, а не словами (bugs/08).');
  console.error(`  отправлено: ${ready.sent}`);
  console.error(`  вернулось : ${ready.got}`);
  console.error(`  потоки питона: ${JSON.stringify(ready.enc)}`);
  process.exit(1);
}

try {
  gatewayToken();
  if (!(await gatewayAlive())) {
    console.error('ЯДРО недоступно: гейтвей OpenClaw не поднят.\nПодними стек: powershell -File F:\\KLAS\\tools\\klas.ps1 -Action up');
    process.exit(1);
  }

  if (wavArg || textArg) {
    await turn(tts, { wav: wavArg, text: textArg });      // автономный прогон (харнесс)
  } else {
    for (;;) {
      const wav = path.join(OUT_DIR, `talk-input-${Date.now()}.wav`);
      const sec = await recordPushToTalk(wav);
      if (sec < 0.6) { rmSync(wav, { force: true }); console.log('Пустая реплика — выхожу. Пока!'); break; }
      // Долгая запись БЕЗ файла — это отказ записи (микрофон/диск/ffmpeg), а не выбор человека:
      // раньше тракт вежливо «прощался», маскируя поломку под интент (ревизия 2026-07-31)
      if (!existsSync(wav)) { console.error('⛔ Запись шла, а файла нет — отказ записи, см. stderr ffmpeg выше. Пробуем ещё раз (выход — короткий Enter).'); continue; }
      try { await turn(tts, { wav }); } catch (e) { console.error(String(e.message || e)); }
      rmSync(wav, { force: true });
    }
  }
} finally {
  tts.stop();
}
