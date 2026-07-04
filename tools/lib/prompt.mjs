// tools/lib/prompt.mjs — интерактивные хелперы мастера (план 05). Zero-deps: node:readline/promises.
// Защита от дурака: переспрос при неверном вводе, дефолты по Enter, 'q' — выход. Все — async.

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

// Сигнал выхода: бросается при 'q'/Ctrl-C, ловится в install.mjs → сохранить состояние и выйти.
export class QuitSignal extends Error {}

function rl() {
  return createInterface({ input: stdin, output: stdout });
}

// Выбор из списка. options: [{key, label}]. defaultIndex — вариант по Enter. Возвращает key.
export async function select(question, options, defaultIndex = 0) {
  const io = rl();
  try {
    while (true) {
      stdout.write(`\n${question}\n`);
      options.forEach((o, i) =>
        stdout.write(`  ${i + 1}) ${o.label}${i === defaultIndex ? ' [Enter]' : ''}\n`)
      );
      const a = (await io.question('> ')).trim().toLowerCase();
      if (a === 'q') throw new QuitSignal();
      if (a === '') return options[defaultIndex].key;
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].key;
      const byKey = options.find((o) => o.key.toLowerCase() === a);
      if (byKey) return byKey.key;
      stdout.write('  ↳ не понял, попробуйте ещё раз (номер варианта) / try again\n');
    }
  } finally {
    io.close();
  }
}

// Да/нет. def — значение по Enter (true=да). Возвращает boolean.
export async function confirm(question, def = true) {
  const io = rl();
  try {
    const hint = def ? '[Д/n]' : '[д/N]';
    while (true) {
      const a = (await io.question(`\n${question} ${hint} `)).trim().toLowerCase();
      if (a === 'q') throw new QuitSignal();
      if (a === '') return def;
      if (['y', 'yes', 'д', 'да'].includes(a)) return true;
      if (['n', 'no', 'н', 'нет'].includes(a)) return false;
      stdout.write('  ↳ введите д/н (y/n)\n');
    }
  } finally {
    io.close();
  }
}

// Свободный текст с дефолтом и опциональной валидацией validate(value)->true|string(ошибка).
export async function text(question, { def = '', validate } = {}) {
  const io = rl();
  try {
    while (true) {
      const a = (await io.question(`\n${question}${def ? ` [${def}]` : ''}: `)).trim();
      if (a.toLowerCase() === 'q') throw new QuitSignal();
      const val = a === '' ? def : a;
      if (validate) {
        const v = validate(val);
        if (v !== true) { stdout.write(`  ↳ ${v}\n`); continue; }
      }
      return val;
    }
  } finally {
    io.close();
  }
}
