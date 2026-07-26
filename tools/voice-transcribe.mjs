#!/usr/bin/env node
// tools/voice-transcribe.mjs — STT-адаптер для OpenClaw (Г4, plans/14): контракт
// `audio.transcription.command` ядра OpenClaw и Talk stt-tts вкладки Voice Android-ноды.
//
// Зачем: нода/гейтвей отдаёт аудио в ПРОИЗВОЛЬНОМ формате (opus/webm/m4a/ogg/wav), а наш
// GigaAM-движок (tools/voice-hear.mjs) читает только WAV. Здесь нормализуем через ffmpeg в
// 16 кГц моно 16-бит WAV и прогоняем через GigaAM. В stdout — ТОЛЬКО распознанный текст
// (этого ждёт `audio.transcription.command`), тайминги/ошибки — в stderr.
//
// Вызов ядром: node tools/voice-transcribe.mjs {{MediaPath}}
// (OpenClaw подставляет путь к аудиофайлу вместо {{MediaPath}}.)

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const input = process.argv[2];
if (!input || !existsSync(input)) {
  console.error('Использование: node tools/voice-transcribe.mjs <audio-файл любого формата>');
  process.exit(1);
}

// ffmpeg: сначала пробуем PATH, потом известный WinGet-шим (окружение спавна ядра может быть урезано)
const FFMPEG_CANDIDATES = [
  process.env.FFMPEG_PATH,
  'ffmpeg',
  'C:\\Users\\krinik\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe',
].filter(Boolean);

function runFfmpeg(args) {
  for (const bin of FFMPEG_CANDIDATES) {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    if (r.error && r.error.code === 'ENOENT') continue; // бинарь не найден — следующий кандидат
    return r;
  }
  return { status: 1, stderr: 'ffmpeg не найден ни в PATH, ни по известному пути' };
}

const tmp = mkdtempSync(path.join(tmpdir(), 'oc-stt-'));
const wav = path.join(tmp, 'in.wav');
try {
  const ff = runFfmpeg(['-y', '-loglevel', 'error', '-i', input, '-ac', '1', '-ar', '16000', '-f', 'wav', wav]);
  if (ff.status !== 0 || !existsSync(wav)) {
    console.error(`ffmpeg-нормализация упала (code=${ff.status}): ${(ff.stderr || '').slice(-300)}`);
    process.exit(1);
  }
  // GigaAM через существующий харнесс voice-hear.mjs (текст → stdout, тайминги → stderr)
  const hear = spawnSync(process.execPath, [path.join(import.meta.dirname, 'voice-hear.mjs'), wav], {
    encoding: 'utf8', timeout: 120_000, windowsHide: true,
  });
  if (hear.stderr) console.error(hear.stderr.trim()); // пробрасываем тайминги GigaAM в stderr (для логов ядра)
  if (hear.status !== 0) {
    console.error(`voice-hear упал (code=${hear.status})`);
    process.exit(1);
  }
  process.stdout.write((hear.stdout || '').trim() + '\n'); // контракт: только распознанный текст
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
