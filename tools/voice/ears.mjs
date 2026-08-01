// tools/voice/ears.mjs — ОДНО распознавание wav на весь тракт (Г2, plans/12).
//
// Вынесено из `voice-talk.mjs`, когда у него появился второй потребитель — диспетчер активаторов
// `voice-wake.mjs`. Причина не в трёх строках кода, а в оплаченном уроке: вторая копия смысла
// расходится с первой молча (так полтора дня правок произношения не доезжали до живого ассистента —
// см. шапку `silero_daemon.py`). Модель ушей выбирается флагом `--ears` (bugs/10), и выбор обязан
// быть один на весь тракт.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const HEAR = path.join(import.meta.dirname, '..', 'voice-hear.mjs');

/**
 * Распознать wav. Возвращает текст (пустая строка = тишина, это НЕ ошибка).
 * @param {string} wav   путь к файлу
 * @param {string} model 'ru' (дефолт тракта) | 'punct' | путь к модели
 */
export function hear(wav, model = 'ru') {
  const r = spawnSync('node', [HEAR, wav, '--model', model],
    { encoding: 'utf8', timeout: 300_000, windowsHide: true });
  if (r.status !== 0) throw new Error(`УШИ упали: ${(r.stderr || '').slice(-200)}`);
  return r.stdout.trim();
}
