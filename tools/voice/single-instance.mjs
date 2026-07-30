// tools/voice/single-instance.mjs — ЗАМОК ЕДИНСТВЕННОЙ ГОЛОСОВОЙ СЕССИИ.
//
// Зачем. 2026-07-28 владелец слышал в колонках неразборчивую кашу и справедливо считал тракт
// сломанным. Расследование (запись микрофоном + разбор по всплескам речи) показало: код был
// исправен, а параллельно работали ДВЕ голосовые сессии — его диалог и звуковой бенч агента, —
// и они говорили в одни колонки одновременно. Наложение двух-трёх фраз на слух неотличимо от
// испорченного звука.
//
// Динамики — это разделяемый ресурс с одним потребителем. Замок делает это правилом, а не надеждой:
// вторая сессия не стартует, а честно скажет, кто уже говорит.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const LOCK = 'F:\\KLAS\\voice\\out\\.voice-session.lock';

function aliveProcess(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }   // сигнал 0 = только проверка
}

/**
 * Занять голосовую сессию. Возвращает {ok:true, release} либо {ok:false, holder} — кто уже говорит.
 * @param {string} who — человекочитаемое имя потребителя (для сообщения второй сессии)
 */
export function acquireVoiceSession(who) {
  mkdirSync(dirname(LOCK), { recursive: true });   // voice/out вне git — на свежей машине его нет
  if (existsSync(LOCK)) {
    try {
      const held = JSON.parse(readFileSync(LOCK, 'utf8'));
      if (held.pid !== process.pid && aliveProcess(held.pid)) return { ok: false, holder: held };
    } catch { /* битый замок — считаем брошенным */ }
    rmSync(LOCK, { force: true });                 // мёртвый/битый замок снимаем, чтобы wx прошёл
  }
  // ЗАХВАТ АТОМАРНЫЙ ({flag:'wx'}): прежний existsSync→write давал TOCTOU-окно, в котором две
  // сессии «захватывали» динамики одновременно — ровно каша инцидента 2026-07-28, от которой
  // замок и защищает (ревизия 2026-07-31).
  try {
    writeFileSync(LOCK, JSON.stringify({ pid: process.pid, who, at: new Date().toISOString() }), { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try { return { ok: false, holder: JSON.parse(readFileSync(LOCK, 'utf8')) }; }
    catch { return { ok: false, holder: { who: 'неизвестно (замок нечитаем)' } }; }
  }
  const release = () => {
    // Снимаем ТОЛЬКО свой замок: иначе сессия, чей замок перезаписан, на выходе снесла бы чужой
    try { if (JSON.parse(readFileSync(LOCK, 'utf8')).pid === process.pid) rmSync(LOCK, { force: true }); }
    catch { /* уже убран или нечитаем — не трогаем */ }
  };
  // Замок не должен пережить процесс: иначе следующая сессия не запустится вовсе
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(130); });
  return { ok: true, release };
}
