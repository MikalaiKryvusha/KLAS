#!/usr/bin/env node
// tools/voice-talk.mjs — «СКЕЛЕТ РАЗГОВОРА» KLAS (фаза Г3, plans/13): первый живой голосовой диалог.
// Каскад: микрофон (push-to-talk) → УШИ (voice-hear, GigaAM) → ЯДРО (OpenClaw, рабочий профиль,
// сессия держит контекст) → РОТ (voice-say, Silero) → динамики. Всё локально, всё офлайн.
//
// Использование:
//   node tools/voice-talk.mjs                     → push-to-talk: Enter — начать, Enter — закончить
//   node tools/voice-talk.mjs --wav вопрос.wav    → автономный прогон каскада из готового wav (без микрофона)
//   node tools/voice-talk.mjs --device "имя dshow-микрофона"   (дефолт — NVIDIA Broadcast)
//   node tools/voice-talk.mjs --no-play           → не проигрывать ответ (тихий тест)
// Выход из диалога: пустая реплика (сразу два Enter) или Ctrl+C.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const HERE = import.meta.dirname;
const OUT_DIR = 'F:\\KLAS\\voice\\out';
const OPENCLAW = path.join(process.env.APPDATA, 'npm', 'node_modules', 'openclaw', 'openclaw.mjs');
const MIC_DEFAULT = 'Микрофон (NVIDIA Broadcast)';   // реальный мик владельца (шумодав NVIDIA)
// Установка голосового стиля — в каждом ходе (надёжнее для локальных моделей, чем один раз за сессию)
const VOICE_STYLE = '(Голосовой запрос. Ответь КРАТКО и разговорно, 1-3 предложения, без markdown, списков и кода.)';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const wavArg = flag('--wav');
const device = flag('--device') ?? MIC_DEFAULT;
const play = !args.includes('--no-play');
const sessionKey = `voice-${new Date().toISOString().slice(0, 10)}`;   // один день = одна беседа

const run = (cmd, a, timeout = 300_000) => spawnSync(cmd, a, { encoding: 'utf8', timeout, windowsHide: true });

// --- этапы каскада ---
function hear(wav) {
  const r = run('node', [path.join(HERE, 'voice-hear.mjs'), wav]);
  if (r.status !== 0) throw new Error(`УШИ упали: ${(r.stderr || '').slice(-200)}`);
  return r.stdout.trim();
}

function think(text) {
  const r = run('node', [OPENCLAW, 'agent', '--local', '--session-key', sessionKey, '--json',
    '--timeout', '300', '-m', `${VOICE_STYLE}\n${text}`], 400_000);
  const out = r.stdout || '';
  const at = out.search(/\{\s*[\r\n]+\s*"payloads"/);
  if (at < 0) throw new Error(`ЯДРО упало (code=${r.status}): ${(out + (r.stderr || '')).slice(-200)}`);
  const j = JSON.parse(out.slice(at));
  return { text: (j.payloads?.[0]?.text || '').trim(), ms: j.meta?.durationMs ?? 0 };
}

function say(text, outWav) {
  const r = run('node', [path.join(HERE, 'voice-say.mjs'), text, '--out', outWav]);
  if (r.status !== 0) throw new Error(`РОТ упал: ${(r.stderr || '').slice(-200)}`);
}

function playWav(wav) {
  run('powershell', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${wav}').PlaySync()`]);
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

// --- один ход диалога: wav → текст → ядро → голос ---
async function turn(wav) {
  const t0 = performance.now();
  const heard = hear(wav);
  const t1 = performance.now();
  if (!heard) { console.log('(тишина — ничего не распознано)'); return; }
  console.log(`\n🎤 Ты: ${heard}`);
  const { text: reply, ms: coreMs } = think(heard);
  const t2 = performance.now();
  console.log(`🤖 KLAS: ${reply}`);
  const replyWav = path.join(OUT_DIR, `talk-reply-${Date.now()}.wav`);
  say(reply, replyWav);
  const t3 = performance.now();
  console.log(`[тайминги] уши ${((t1 - t0) / 1000).toFixed(1)} с · ядро ${(coreMs / 1000).toFixed(1)} с · рот ${((t3 - t2) / 1000).toFixed(1)} с · всего ${((t3 - t0) / 1000).toFixed(1)} с`);
  if (play) playWav(replyWav);
  return replyWav;
}

// --- main ---
if (!existsSync(OPENCLAW)) { console.error(`Нет openclaw: ${OPENCLAW}`); process.exit(1); }
if (wavArg) {
  // Автономный режим: один ход из готового файла (харнесс-проверка каскада без микрофона)
  await turn(wavArg);
} else {
  console.log(`Голосовой диалог с KLAS (сессия ${sessionKey}, микрофон: ${device}).`);
  for (;;) {
    const wav = path.join(OUT_DIR, `talk-input-${Date.now()}.wav`);
    const sec = await recordPushToTalk(wav);
    if (sec < 0.6 || !existsSync(wav)) { rmSync(wav, { force: true }); console.log('Пустая реплика — выхожу. Пока!'); break; }
    try { await turn(wav); } catch (e) { console.error(String(e.message || e)); }
    rmSync(wav, { force: true });
  }
}
