#!/usr/bin/env node
// tools/try-model.mjs — попробовать модель с Hugging Face одной командой (идея 06):
// скачивает GGUF (с докачкой), гонит скоростной бенч и печатает сниппет для llama-swap.
//
// Запуск: node tools/try-model.mjs <hf-repo> <файл.gguf>
// Пример: node tools/try-model.mjs unsloth/Qwen3.6-27B-MTP-GGUF Qwen3.6-27B-UD-IQ3_XXS.gguf
//
// После добавления сниппета в llama-swap/config.yaml и перезапуска llama-swap «ум» меряется:
//   node tools/agent-bench.mjs <alias>

import { createWriteStream, existsSync, statSync, renameSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const [repo, file] = process.argv.slice(2);
if (!repo || !file) { console.error('Использование: node tools/try-model.mjs <hf-repo> <файл.gguf>'); process.exit(1); }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = join(ROOT, 'LLMs', 'LLAMACPP_MODELS');
const dest = join(MODELS_DIR, basename(file));
const url = `https://huggingface.co/${repo}/resolve/main/${file}`;

// 1. Скачивание с докачкой (.part)
if (existsSync(dest)) {
  console.log(`✓ файл уже скачан: ${dest} (${(statSync(dest).size / 1e9).toFixed(2)} GB)`);
} else {
  const part = dest + '.part';
  const have = existsSync(part) ? statSync(part).size : 0;
  console.log(`↓ качаю ${url}${have ? ` (докачка с ${(have / 1e6).toFixed(0)} MB)` : ''}`);
  const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: 'follow' });
  if (!res.ok && res.status !== 206) { console.error(`✖ HTTP ${res.status} — проверь repo/имя файла`); process.exit(1); }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part, { flags: res.status === 206 ? 'a' : 'w' }));
  renameSync(part, dest);
  console.log(`✓ скачано: ${(statSync(dest).size / 1e9).toFixed(2)} GB`);
}

// 2. Скоростной бенч (pp512/tg128, GPU, flash attention)
console.log('\n— скоростной бенч (llama-bench) —');
execFileSync('powershell', ['-File', join(ROOT, 'tools', 'bench-model.ps1'), '-Model', dest], { stdio: 'inherit' });

// 3. Сниппет для llama-swap
const alias = basename(file, '.gguf').toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/(^-|-$)/g, '');
console.log(`\n— дальше: добавь в llama-swap/config.yaml (models:) и перезапусти llama-swap —\n`);
console.log(`  "${alias}":
    cmd: >
      F:\\KLAS\\llamacpp\\llama-server.exe
      -m ${dest}
      --port \${PORT} -c 32768 -ngl 99 --flash-attn on -b 2048 -ub 1024 --jinja
      -np 1 --slots --cont-batching
    ttl: 300
`);
console.log(`затем «ум»: node tools/agent-bench.mjs ${alias}`);
