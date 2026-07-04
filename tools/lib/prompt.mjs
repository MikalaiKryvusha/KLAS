// tools/lib/prompt.mjs — интерактивные хелперы мастера (план 05). Zero-deps: node:readline.
// Защита от дурака: переспрос при неверном вводе, дефолты по Enter, 'q' — выход. Все — async.
//
// Читаем через ОЧЕРЕДЬ строк (persistent 'line'-слушатель): так буферизованные строки из пайпа не
// теряются между вопросами (readline/promises.question() их терял) — работает и в терминале, и при
// `type answers.txt | node install.mjs`. EOF → ask() возвращает null; вызывающий берёт дефолт.

import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';

export class QuitSignal extends Error {}

let _rl = null;
let _closed = false;
const _queue = [];      // накопленные строки ввода
let _waiter = null;     // ожидающий resolver, если очередь пуста

function ensure() {
  if (_rl) return;
  _rl = createInterface({ input: stdin });
  _rl.on('line', (l) => { if (_waiter) { const w = _waiter; _waiter = null; w(l); } else _queue.push(l); });
  _rl.on('close', () => { _closed = true; if (_waiter) { const w = _waiter; _waiter = null; w(null); } });
}

function ask(promptStr) {
  ensure();
  stdout.write(promptStr);
  return new Promise((resolve) => {
    if (_queue.length) return resolve(_queue.shift());
    if (_closed) return resolve(null);
    _waiter = resolve;
  });
}

export function closePrompts() { if (_rl) { _rl.close(); _rl = null; } }

const norm = (s) => (s == null ? null : s.trim().toLowerCase());

// Выбор из списка. options: [{key, label}]. defaultIndex — вариант по Enter. Возвращает key.
export async function select(question, options, defaultIndex = 0) {
  stdout.write(`\n${question}\n`);
  options.forEach((o, i) => stdout.write(`  ${i + 1}) ${o.label}${i === defaultIndex ? ' [Enter]' : ''}\n`));
  while (true) {
    const a = norm(await ask('> '));
    if (a === null) return options[defaultIndex].key;   // EOF → дефолт
    if (a === 'q') throw new QuitSignal();
    if (a === '') return options[defaultIndex].key;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].key;
    const byKey = options.find((o) => o.key.toLowerCase() === a);
    if (byKey) return byKey.key;
    stdout.write('  ↳ не понял, введите номер варианта / enter the option number\n');
  }
}

// Да/нет. def — значение по Enter. Возвращает boolean.
export async function confirm(question, def = true) {
  const hint = def ? '[Д/n]' : '[д/N]';
  while (true) {
    const a = norm(await ask(`\n${question} ${hint} `));
    if (a === null) return def;                         // EOF → дефолт
    if (a === 'q') throw new QuitSignal();
    if (a === '') return def;
    if (['y', 'yes', 'д', 'да'].includes(a)) return true;
    if (['n', 'no', 'н', 'нет'].includes(a)) return false;
    stdout.write('  ↳ введите д/н (y/n)\n');
  }
}

// Множественный выбор. options: [{key,label}]. Ввод: номера через запятую (1,3,5); Enter — ничего.
export async function multiselect(question, options) {
  stdout.write(`\n${question}\n`);
  options.forEach((o, i) => stdout.write(`  ${i + 1}) ${o.label}\n`));
  while (true) {
    const a = norm(await ask('\nНомера через запятую (напр. 1,3), Enter — ничего: '));
    if (a === null || a === '') return [];
    if (a === 'q') throw new QuitSignal();
    const idx = [...new Set(a.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= options.length))];
    if (idx.length) return idx.map((i) => options[i - 1].key);
    stdout.write('  ↳ введите номера вариантов через запятую / enter numbers\n');
  }
}

// Свободный текст с дефолтом и опциональной валидацией validate(value)->true|string(ошибка).
export async function text(question, { def = '', validate } = {}) {
  while (true) {
    const raw = await ask(`\n${question}${def ? ` [${def}]` : ''}: `);
    if (raw === null) return def;                       // EOF → дефолт
    const a = raw.trim();
    if (a.toLowerCase() === 'q') throw new QuitSignal();
    const val = a === '' ? def : a;
    if (validate) { const v = validate(val); if (v !== true) { stdout.write(`  ↳ ${v}\n`); continue; } }
    return val;
  }
}
