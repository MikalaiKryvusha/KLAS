#!/usr/bin/env node
// tools/voice-wake.mjs — «ИМЯ ОТКРЫВАЕТ РАЗГОВОР» (план 19, шаг 5).
//
// Что изменилось против `voice-talk.mjs`: там разговор начинался нажатием Enter, здесь — ИМЕНЕМ.
// Сказал «Джарвис» — отвечает Джарвис своим голосом и характером; сказал «Джой» — отвечает Джой.
// Слово-активатор выбирает персону целиком (голос + промпт + своя беседа у ядра), поэтому две
// обученные модели — это фича переключения персон, а не дублирование (`researches/16` §5).
//
// Каскад: слушатель (`tools/voice/wakeword-listen.py`: детекция + захват фразы) → УШИ (GigaAM) →
// ЯДРО (резидентный гейтвей, SSE) → РОТ (резидентный Silero, диктор персоны) → динамики.
// Ход исполняет ОБЩИЙ конвейер `tools/voice/pipeline.mjs` — тот же, что у `voice-talk` и у бенча.
//
// ⭐ ДВА РЕШЕНИЯ ВЛАДЕЛЬЦА (2026-08-01, чат) — они и определили поведение:
//   1. «Слушать всегда, имя перебивает». Детектор НЕ глушится, пока ассистент говорит: услышал имя
//      посреди своей реплики — немедленно замолкает и слушает. Честная цена названа владельцу до
//      выбора: AEC у нас нет, значит детектор слышит и СОБСТВЕННЫЙ голос из колонок (EXP-0017), и
//      ложное самоперебивание возможно. Каждое перебивание печатается с оценкой — чтобы это было
//      видно, а не гадаемо. Обратный режим оставлен флагом `--mute-while-speaking`.
//   2. Короткий бип сразу после имени — сигнал «услышал». Не голосом: голос стоил бы ~1 с на каждое
//      обращение.
//
// Использование:
//   node tools/voice-wake.mjs                       → слушать микрофон, пока не Ctrl+C
//   node tools/voice-wake.mjs --wav фикстура.wav    → прогон БЕЗ микрофона и БЕЗ человека (харнесс)
//   node tools/voice-wake.mjs --wav ф.wav --realtime → то же, но в темпе живой речи (проверки на время)
//   node tools/voice-wake.mjs --no-play             → не проигрывать ответ (тихий тест)
//   node tools/voice-wake.mjs --device "имя dshow-микрофона"
//   node tools/voice-wake.mjs --voice-joy baya      → сменить голос-заглушку Джой (см. personas.mjs)
//   node tools/voice-wake.mjs --ears punct          → уши с пунктуацией и латиницей (bugs/10)
//   node tools/voice-wake.mjs --threshold 0.6       → строже к срабатыванию
//   node tools/voice-wake.mjs --mute-while-speaking → не слушать, пока говорит сам (без перебивания)
//
// ⚠️ Требуется ПОДНЯТЫЙ гейтвей OpenClaw (`powershell -File tools\klas.ps1 -Action up`).
// [NOT-TESTED на живом микрофоне] — сквозной прогон из файла пройден 2026-08-01, вердикт за владельцем.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { TtsDaemon } from './voice/tts-daemon.mjs';
import { gatewayAlive, gatewayToken, runTurn, VOICE_STYLE } from './voice/pipeline.mjs';
import { acquireVoiceSession } from './voice/single-instance.mjs';
import { PERSONAS, personaByDetector } from './voice/personas.mjs';
import { hear } from './voice/ears.mjs';

const OUT_DIR = 'F:\\KLAS\\voice\\out';
const PY_WAKE = 'F:\\KLAS\\voice\\venv-wakeword\\Scripts\\python.exe';   // venv активаторов (вне git)
const LISTENER = path.join(import.meta.dirname, 'voice', 'wakeword-listen.py');
const BEEP = path.join(OUT_DIR, 'wake-beep.wav');

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const wavArg = flag('--wav');
const device = flag('--device');            // null ⇒ дефолт живёт в сайдкаре (один дефолт на систему)
const ears = flag('--ears') ?? 'ru';
const threshold = flag('--threshold');
const play = !args.includes('--no-play');
const muteWhileSpeaking = args.includes('--mute-while-speaking');
const day = new Date().toISOString().slice(0, 10);

// Голоса персон можно подменить флагом, не трогая канон: клоны в резидентный рот не встроены,
// и голос Джой сегодня — заглушка (см. шапку personas.mjs).
for (const [slug, opt] of [['jarvis', '--voice-jarvis'], ['joy', '--voice-joy']]) {
  const v = flag(opt);
  if (v) PERSONAS[slug].voice = v;
}

// --- Бип «услышал»: 0.15 с, 880 Гц, со сглаженными краями ---
// Собирается кодом, а не хранится файлом: бинарник в git ради 4 КБ синуса — лишняя сущность, а
// «сделал руками — оставь скрипт» здесь выполняется тем, что генератор И ЕСТЬ исходник (план 19,
// разбор невоспроизводимой фикстуры).
function ensureBeep() {
  if (existsSync(BEEP)) return BEEP;
  const sr = 16000, sec = 0.15, n = Math.round(sr * sec), fade = Math.round(sr * 0.01);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / fade, (n - i) / fade);   // без сглаживания края дают щелчок
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 880 * i) / sr) * 9000 * env), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(BEEP, Buffer.concat([h, pcm]));
  return BEEP;
}

// --- Воспроизведение с возможностью ПЕРЕБИТЬ ---
// Ход держит своё состояние: перебили — оставшиеся фразы не играют вовсе, а текущая обрывается
// смертью проигрывателя. Ссылка на процесс нужна именно для этого.
let turn = null;          // {aborted, player, persona}
function playWav(wav) {
  return new Promise((resolve) => {
    if (!play || turn?.aborted) return resolve();
    const p = spawn('powershell', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${wav}').PlaySync()`], { windowsHide: true });
    if (turn) turn.player = p;
    p.on('error', () => resolve());
    p.on('close', () => { if (turn?.player === p) turn.player = null; resolve(); });
  });
}

function bargeIn(detector, score) {
  if (!turn || turn.aborted) return false;
  turn.aborted = true;
  try { turn.player?.kill(); } catch { /* уже завершился */ }
  console.log(`\n✋ перебито на «${PERSONAS[detector]?.name ?? detector}» (${score}) — замолкаю`);
  return true;
}

// --- Один разговорный ход по услышанному вопросу ---
async function handleUtterance(persona, wav) {
  const t0 = performance.now();
  let heard = '';
  try { heard = hear(wav, ears); } finally { rmSync(wav, { force: true }); }
  if (!heard) { console.log('(тишина — ничего не распознано)'); return; }
  const earsMs = performance.now() - t0;
  console.log(`🎤 Ты → ${persona.name}: ${heard}`);

  turn = { aborted: false, player: null, persona };
  const state = turn;
  try {
    const r = await runTurn({
      // Один резидентный рот на обе персоны: диктор задаётся НА ВЫЗОВ (tts-daemon.mjs).
      tts: { say: (text, out) => tts.say(text, out, persona.voice) },
      question: heard,
      // Своя беседа на каждую персону: общий ключ дал бы Джой память и реплики Джарвиса.
      user: `voice-${day}-${persona.slug}`,
      outDir: OUT_DIR,
      style: `${persona.prompt}\n${VOICE_STYLE}`,
      playFn: playWav,
    });
    const sec = (ms) => (ms / 1000).toFixed(1);
    console.log(`${state.aborted ? '🤖 (оборвано) ' : '🤖 '}${persona.name}: ${r.reply}`);
    for (const s of r.sentences.filter((x) => !x.ok)) {
      if (s.reason === 'nothing-to-say') console.log(`(не озвучено: «${s.text}» — ни букв, ни цифр, bugs/06)`);
      else console.error(`РОТ споткнулся на «${s.text}»: ${s.reason}`);
    }
    const ttfa = r.ttfaMs === null ? '—' : sec(earsMs + r.ttfaMs);
    console.log(`[тайминги] уши ${sec(earsMs)} с · ядро ${sec(r.coreMs)} с · всего ${sec(earsMs + r.totalMs)} с · ⚡TTFA ${ttfa} с`);
  } catch (e) {
    console.error(String(e.message || e));
  } finally {
    if (turn === state) turn = null;
  }
}

// --- main ---
if (play) {
  const lock = acquireVoiceSession('voice-wake');
  if (!lock.ok) {
    console.error(`Уже идёт голосовая сессия: ${lock.holder.who} (pid ${lock.holder.pid}, с ${lock.holder.at}).`);
    console.error('Две сессии говорят в одни колонки — на слух это каша. Закончи ту или запусти с --no-play.');
    process.exit(1);
  }
}

const tts = new TtsDaemon();      // диктор задаётся на каждый вызов say(), см. handleUtterance
const ready = await tts.ready();
if (ready.stage === 'dead') { console.error('РОТ не запустился — см. venv F:\\KLAS\\voice\\venv (plans/11)'); process.exit(1); }
if (ready.stage === 'encoding-broken') {
  console.error('РОТ отвечает в неверной кодировке — речь была бы моджибейком, а не словами (bugs/08).');
  console.error(`  отправлено: ${ready.sent}\n  вернулось : ${ready.got}`);
  process.exit(1);
}
gatewayToken();
if (!(await gatewayAlive())) {
  console.error('ЯДРО недоступно: гейтвей OpenClaw не поднят.\nПодними стек: powershell -File F:\\KLAS\\tools\\klas.ps1 -Action up');
  process.exit(1);
}
ensureBeep();

// `--parent`: слушатель обязан уйти вместе со мной. Без этого мой аварийный выход оставил бы
// ffmpeg держать микрофон, и следующий запуск не смог бы его открыть.
const listenerArgs = [LISTENER, '--out-dir', OUT_DIR, '--parent'];
if (wavArg) listenerArgs.push('--wav', wavArg);
if (args.includes('--realtime')) listenerArgs.push('--realtime');
if (device) listenerArgs.push('--device', device);
if (threshold) listenerArgs.push('--threshold', threshold);
const listener = spawn(PY_WAKE, listenerArgs, { windowsHide: true });
listener.on('error', (e) => { console.error(`Слушатель не запустился: ${e.message}`); process.exit(1); });
listener.stderr.on('data', (d) => { const s = String(d).trim(); if (s) console.error(`[слушатель] ${s.slice(0, 300)}`); });

// Ходы идут ПО ОДНОМУ: перебив ответ, человек задаёт следующий вопрос, а прошлый ход в это время
// ещё дописывается ядром. Два одновременных хода в одну беседу ядра — гонка, которой здесь не место.
let chain = Promise.resolve();
let done = false;

readline.createInterface({ input: listener.stdout }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }

  if (m.stage === 'ready') {
    console.log('='.repeat(68));
    console.log('  СЛУШАЮ ИМЕНА — скажи «Джарвис» или «Джой»');
    console.log('='.repeat(68));
    console.log(`  ${Object.values(PERSONAS).map((p) => `${p.name} → голос ${p.voice}`).join('   ·   ')}`);
    console.log(`  источник: ${m.source === 'wav' ? wavArg : m.device}   ·   уши: ${ears}`);
    console.log(`  ${muteWhileSpeaking ? 'пока говорю — не слушаю' : 'перебивать можно: скажи имя, пока говорю'}`);
    console.log(`${'='.repeat(68)}\n`);
    return;
  }
  if (m.stage === 'error') { console.error(`Слушатель отказал: ${JSON.stringify(m)}`); process.exitCode = 1; return; }
  if (m.stage === 'eof') { done = true; chain.then(() => shutdown(0)); return; }

  if (m.event === 'wake') {
    const persona = personaByDetector(m.detector);
    if (!persona) { console.error(`Неизвестный детектор «${m.detector}» — раскладка персон разошлась с моделями`); return; }
    if (!bargeIn(m.detector, m.score)) console.log(`\n🔔 ${persona.name} (${m.score})`);
    // Сигнал «услышал» (решение владельца). Не ждём его окончания: слушатель уже пишет фразу.
    // Замер 2026-08-01: 0.36 с накладных на запуск проигрывателя + 0.15 с самого тона.
    if (play) playWav(BEEP);
    return;
  }
  if (m.event === 'empty') { console.log('   (только имя — жду вопроса)'); return; }
  if (m.event === 'utterance') {
    const persona = personaByDetector(m.detector);
    if (!persona) return;
    chain = chain.then(async () => {
      if (muteWhileSpeaking) listener.stdin.write('{"cmd":"listen","on":false}\n');
      try { await handleUtterance(persona, m.wav); }
      finally { if (muteWhileSpeaking) listener.stdin.write('{"cmd":"listen","on":true}\n'); }
    });
  }
});

listener.on('close', () => { if (!done) shutdown(process.exitCode ?? 0); });

function shutdown(code) {
  try { listener.stdin.write('{"cmd":"quit"}\n'); } catch { /* уже мёртв */ }
  try { listener.kill(); } catch { /* уже мёртв */ }
  tts.stop();
  process.exit(code);
}

process.on('SIGINT', () => { console.log('\nПока!'); shutdown(0); });
