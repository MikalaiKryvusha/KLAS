// tools/voice/piper-dataset-guard.mjs — охранник корпуса обучения Piper.
//
// ЗАЧЕМ ОН СУЩЕСТВУЕТ (bugs/18, 2026-07-30)
// -----------------------------------------
// Piper читает `metadata.csv` питоновским `csv.reader(f, delimiter='|')`. Разделитель мы задали,
// а вот `quotechar` остался ДЕФОЛТНЫМ — это `"`. Поэтому двойная кавычка В НАЧАЛЕ текстового поля
// открывает закавыченное поле, и парсер глотает строки файла до следующей `"`.
//
// У нас это выстрелило ровно один раз и молча: в строке 1082 расшифровка ушей начиналась с `"`,
// закрывающей кавычки дальше в файле не было — и `csv.reader` склеил в ОДНУ реплику весь остаток
// корпуса, 104 реплики сразу. Обучение при этом НЕ пожаловалось на данные: оно упало через 37
// шагов с `CUDA out of memory. Tried to allocate 49.93 GiB` — матрица внимания квадратична по
// длине фонемной строки, а строка выросла со 117 фонем (медиана) до 20 465.
//
// То есть дефект ДАННЫХ выглядел как дефект ЖЕЛЕЗА. Это тот же класс, что `bugs/16` и EXP-0036:
// парный вход (звук + текст), половины которого разъехались, — только здесь их развела не обрезка,
// а кавычка.
//
// ЛЕЧЕНИЕ — не «научиться разбирать кавычки», а гарантировать ПРЕДУСЛОВИЕ: в тексте не должно быть
// ни одного символа, который `csv.reader` трактует специально. Тогда неверный разбор невозможен
// в принципе, и нам не приходится повторять семантику чужого парсера у себя (Оккам).
//
// Использование:
//   node tools/voice/piper-dataset-guard.mjs                      # самопроверка
//   node tools/voice/piper-dataset-guard.mjs <metadata.csv>       # проверить корпус
//   node tools/voice/piper-dataset-guard.mjs <metadata.csv> --fix # проверить и вылечить на месте

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

/**
 * Привести текст реплики к виду, безопасному для `csv.reader(delimiter='|')`.
 *
 * `"` — quotechar парсера. Мы его УДАЛЯЕМ, а не экранируем: для синтеза речи прямая кавычка
 * не значит ничего (интонацию она не несёт, а espeak-ng её игнорирует), зато любой её остаток
 * возвращает нас к разбору кавычек. Ёлочки «» в корпусе остаются — они парсеру не мешают.
 * `|` — разделитель полей: в тексте он разрезал бы строку на лишние колонки.
 * Переводы строки и `\r` схлопываем в пробел: строка CSV обязана быть одной строкой файла.
 */
export function sanitizeText(text) {
  return String(text)
    .replace(/"/g, '')
    .replace(/\|/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Проверить инвариант корпуса. Возвращает {ok, rows, problems[]}.
 * Проверяем ПРЕДУСЛОВИЕ разбора, а не результат разбора: если ни одной `"` в файле нет,
 * `csv.reader` не может склеить строки, и повторять его логику на JS не требуется.
 */
export function verifyMetadata(csvPath) {
  const raw = readFileSync(csvPath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const problems = [];

  // ПУСТОЙ корпус — не «ноль проблем», а красный: сборщик со сломанным ffmpeg/NaN-аргументами
  // отдавал 0 сегментов, охранник зеленел на пустоте, и «ГОТОВО: 0 реплик» уходило кодом 0
  // (ревизия 2026-07-31).
  if (lines.length === 0) problems.push({ row: 0, kind: 'empty-corpus', line: '(файл пуст)' });

  lines.forEach((line, i) => {
    const n = i + 1;
    if (line.includes('"')) problems.push({ row: n, kind: 'quotechar', line });
    if (line.includes('\r')) problems.push({ row: n, kind: 'cr', line });
    const parts = line.split('|');
    if (parts.length !== 2) problems.push({ row: n, kind: `columns=${parts.length}`, line });
    else if (parts[1].trim().length === 0) problems.push({ row: n, kind: 'empty-text', line });
  });

  return { ok: problems.length === 0, rows: lines.length, problems };
}

/** Вылечить корпус на месте (с резервной копией рядом). Возвращает число исправленных строк. */
export function fixMetadata(csvPath) {
  const raw = readFileSync(csvPath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.length > 0);
  let fixed = 0;
  const out = lines.map((line) => {
    const cut = line.indexOf('|');
    if (cut < 0) return line;
    const name = line.slice(0, cut);
    const text = line.slice(cut + 1);
    const clean = sanitizeText(text);
    if (clean !== text) fixed++;
    return `${name}|${clean}`;
  });
  const backup = `${csvPath}.before-guard`;
  if (!existsSync(backup)) copyFileSync(csvPath, backup);
  writeFileSync(csvPath, out.join('\n') + '\n', 'utf8');
  return fixed;
}

// ---------------------------------------------------------------------------
// Запуск без аргументов — САМОПРОВЕРКА. Охранник, который ни разу не краснел, не доказывает
// ничего (BUG_FIXING_FRAMEWORK → «Охранники»), поэтому первым же случаем ему подаётся ДОСЛОВНО
// та строка, что породила дефект.
// ---------------------------------------------------------------------------
function selfTest() {
  const cases = [
    // [что подаём, что должно получиться, зачем этот случай]
    ['"А я подготовлю дюжину вооружённых бойцов», — сказал шеф.',
     'А я подготовлю дюжину вооружённых бойцов», — сказал шеф.',
     'ДОСЛОВНАЯ строка 1082 — та самая, что съела 104 реплики и дала OOM на 49.93 ГиБ'],
    ['"Это", - сказал начальник департамента.',
     'Это, - сказал начальник департамента.',
     'кавычка в начале, но ЗАКРЫТАЯ — тут парсер не ломался, а чистить всё равно надо'],
    ['«Это мне нравится», — сказал он Артур',
     '«Это мне нравится», — сказал он Артур',
     'ёлочки парсеру не мешают — обратный случай, текст НЕ должен пострадать'],
    ['Я сказал: "Этого достаточно»',
     'Я сказал: Этого достаточно»',
     'кавычка в СЕРЕДИНЕ поля: парсер её терпит, но она мина под следующую правку'],
    ['текст с | трубой внутри',
     'текст с   трубой внутри'.replace(/\s+/g, ' '),
     'разделитель полей в тексте разрезал бы строку на лишние колонки'],
    ['строка\nс переводом',
     'строка с переводом',
     'перевод строки превратил бы одну реплику в две'],
  ];

  let pass = 0;
  console.log('=== самопроверка sanitizeText ===');
  for (const [input, want, why] of cases) {
    const got = sanitizeText(input);
    const ok = got === want;
    if (ok) pass++;
    console.log(`${ok ? 'PASS' : 'FAIL'} · ${why}`);
    if (!ok) console.log(`     подали: ${JSON.stringify(input)}\n     ждали:  ${JSON.stringify(want)}\n     вышло:  ${JSON.stringify(got)}`);
  }

  // Инвариант: после чистки в тексте не остаётся ни одного символа, специального для csv.reader.
  const invariant = cases.every(([input]) => !/["|\r\n]/.test(sanitizeText(input)));
  console.log(`${invariant ? 'PASS' : 'FAIL'} · инвариант: после чистки не осталось ни " ни | ни перевода строки`);

  // Пустой корпус обязан краснеть (ревизия 2026-07-31): «0 строк = 0 проблем» пропускало
  // несобранный датасет в обучение.
  const emptyCsv = `${process.env.TEMP || '/tmp'}/piper-guard-selftest-empty.csv`;
  writeFileSync(emptyCsv, '\n', 'utf8');
  const emptyRed = !verifyMetadata(emptyCsv).ok;
  console.log(`${emptyRed ? 'PASS' : 'FAIL'} · пустой корпус не проходит охранника`);

  const total = cases.length + 2;
  const good = pass + (invariant ? 1 : 0) + (emptyRed ? 1 : 0);
  console.log(`\nИТОГО: ${good}/${total}`);
  return good === total;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
    process.argv[1]?.endsWith('piper-dataset-guard.mjs')) {
  const target = process.argv[2];
  if (!target) {
    process.exit(selfTest() ? 0 : 1);
  }
  const before = verifyMetadata(target);
  console.log(`${target}: строк ${before.rows}, проблем ${before.problems.length}`);
  for (const p of before.problems) console.log(`  строка ${p.row} · ${p.kind} · ${p.line.slice(0, 100)}`);

  if (process.argv.includes('--fix')) {
    const fixed = fixMetadata(target);
    const after = verifyMetadata(target);
    console.log(`\nвылечено строк: ${fixed}; резервная копия — ${target}.before-guard`);
    console.log(`после лечения: строк ${after.rows}, проблем ${after.problems.length}`);
    process.exit(after.ok ? 0 : 1);
  }
  process.exit(before.ok ? 0 : 1);
}
