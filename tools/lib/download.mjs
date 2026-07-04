// tools/lib/download.mjs — резюмируемое скачивание файла с прогрессом (план 05).
// Используется мастером для .zim баз знаний. Докачка через Range + .part, атомарный rename.

import { createWriteStream, existsSync, statSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

const human = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} ГБ` : `${(b / 1e6).toFixed(0)} МБ`);

// Мини-Transform: считает прошедшие байты и зовёт onChunk(len), пропуская данные дальше.
class ByteCounter extends Transform {
  constructor(onChunk) { super(); this._on = onChunk; }
  _transform(chunk, _enc, cb) { this._on(chunk.length); cb(null, chunk); }
}

// Скачать url → destAbs. Докачивает .part, показывает прогресс. Возвращает true.
export async function downloadFile(url, destAbs, label = '') {
  mkdirSync(dirname(destAbs), { recursive: true });
  if (existsSync(destAbs)) return true;               // уже скачан (идемпотентность)
  const part = destAbs + '.part';
  const have = existsSync(part) ? statSync(part).size : 0;
  const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: 'follow' });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
  const append = res.status === 206;                  // сервер поддержал докачку
  const total = Number(res.headers.get('content-length') || 0) + (append ? have : 0);
  let done = have;
  let lastPct = -1;
  const counter = new ByteCounter((n) => {
    done += n;
    const pct = total ? Math.floor((done / total) * 100) : -1;
    if (pct !== lastPct) { lastPct = pct; process.stdout.write(`\r  ${label} ${human(done)}${total ? ` / ${human(total)} (${pct}%)` : ''}   `); }
  });
  await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(part, { flags: append ? 'a' : 'w' }));
  process.stdout.write('\n');
  renameSync(part, destAbs);
  return true;
}
