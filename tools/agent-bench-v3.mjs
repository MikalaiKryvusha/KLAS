#!/usr/bin/env node
// tools/agent-bench-v3.mjs — агентный бенч KLAS, версия 3 (ГЛУБОКИЙ, ГРАДУИРОВАННЫЙ, СБАЛАНСИРОВАННЫЙ).
// v2 де-сатурировал бенч, но был почти однотурновым. v3 меряет модель как АГЕНТА под реальные задачи
// KLAS (Zoo Code / автобеклог): межфайловый код, ЦЕПОЧКИ tool-call 3+ с ветвлением, удержание инструкции
// на длинной сессии, длинный контекст с ДИСТРАКТОРАМИ, тонкая отладка, планирование (топосорт),
// извлечение под шумом, + кислотный перенос из v2. Баланс: код × рассуждение × язык × длинный контекст.
//
// ОЦЕНКА ГРАДУИРОВАННАЯ: каждая задача → дробь 0..1 (доля пройденных под-кейсов). Итог = сумма (макс 8.0).
// Проверки СТРОГИ по сути, СНИСХОДИТЕЛЬНЫ к оформлению (снимаем ``` , trim, регистр где уместно).
//
// Запуск: node tools/agent-bench-v3.mjs <model> [--base http://127.0.0.1:8080]
// Требует поднятый llama-swap/llama-server (--jinja для tool calling).

const MODEL = process.argv[2];
if (!MODEL) { console.error('Использование: node tools/agent-bench-v3.mjs <model> [--base URL]'); process.exit(1); }
const BASE = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'http://127.0.0.1:8080';

// --- утилиты ---
const nums = (s) => (String(s).match(/-?\d+(?:[.,]\d+)?/g) || []).map((x) => parseFloat(x.replace(',', '.')));
const nearNum = (s, t, eps = 0.05) => nums(s).some((v) => Math.abs(v - t) <= eps);
const stripFence = (s) => (s || '').replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
const firstJSON = (s) => { const m = stripFence(s).match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } };

async function chat(messages, { tools, max_tokens = 300, temperature = 0.1 } = {}) {
  const body = { model: MODEL, messages, max_tokens, temperature };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).choices[0].message;
}
const runCode = (code, tail) => { try { return new Function(`${stripFence(code)}\n; return (${tail});`)(); } catch { return undefined; } };

// длинный контекст с ДИСТРАКТОРАМИ (несколько похожих «секретов» + правка факта позже)
const FILL = 'KLAS — локальная агентская ИИ-система на llama.cpp и llama-swap; стабильность важнее ума, ум важнее скорости. ';
const LONG = FILL.repeat(90)
  + 'Код доступа для ГОСТЯ: 111. ' + FILL.repeat(60)
  + 'Порт сервиса указан как 8080. ' + FILL.repeat(60)
  + 'Код доступа для АДМИНА: 999. ' + FILL.repeat(60)
  + 'Код доступа для СЕРВИСА: 555. ' + FILL.repeat(60)
  + 'ВАЖНОЕ УТОЧНЕНИЕ: порт сервиса изменён и теперь равен 8090 (прежнее значение недействительно). ' + FILL.repeat(40);

// --- задачи v3: async run() → число 0..1 ---
const TASKS = [
  {
    id: 'cross-file-code', kind: 'код·межфайл',
    // Дан модуль A (discount). Написать B (totalWithDiscount), использующий интерфейс A.
    async run() {
      const A = 'function discount(price, pct){ return price - price*pct/100; }';
      const m = await chat([{ role: 'user', content: `Модуль A уже определён:\n${A}\nНапиши функцию totalWithDiscount(items, pct): суммирует массив цен items, применяет discount к сумме и возвращает результат. Используй уже существующую функцию discount. Верни ТОЛЬКО код функции totalWithDiscount.` }]);
      const fn = runCode(`${A}\n${stripFence(m.content)}`, 'totalWithDiscount');
      if (typeof fn !== 'function') return 0;
      const cases = [[[100, 200], 10, 270], [[], 10, 0], [[50], 50, 25], [[10, 20, 70], 0, 100]];
      let ok = 0; for (const [it, p, exp] of cases) { try { if (Math.abs(fn(it, p) - exp) < 0.01) ok++; } catch {} }
      return ok / cases.length;
    },
  },
  {
    id: 'tool-chain-branch', kind: 'агентность·ветвл', multiturn: true,
    // list_files → read_file(config.json) → раз debug:true, выключить его через set_config.
    async run() {
      const tools = [
        { type: 'function', function: { name: 'list_files', description: 'Список файлов', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'read_file', description: 'Прочитать файл', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
        { type: 'function', function: { name: 'set_config', description: 'Изменить настройку', parameters: { type: 'object', properties: { key: { type: 'string' }, value: {} }, required: ['key', 'value'] } } },
        { type: 'function', function: { name: 'report', description: 'Отчитаться о статусе', parameters: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] } } },
      ];
      const messages = [
        { role: 'system', content: 'Ты агент KLAS. Работай инструментами пошагово: сначала узнай факты, потом действуй по условию. Не выдумывай.' },
        { role: 'user', content: 'Проверь файл config.json: если в нём debug включён (true) — выключи его (set_config debug=false). Если выключен — просто отчитайся, что всё ок.' },
      ];
      let readConfig = false, noPrematureAction = true, terminalOk = false, actedAlready = false;
      for (let round = 0; round < 5; round++) {
        let m;
        try { m = await chat(messages, { tools, max_tokens: 200 }); }
        catch { break; }   // ошибка раунда (напр. кривой tool-JSON от модели) — не обнуляем уже набранное
        const call = m.tool_calls?.[0];
        if (!call) break;
        messages.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });
        const name = call.function.name; let a = {}; try { a = JSON.parse(call.function.arguments || '{}'); } catch {}
        if ((name === 'set_config' || name === 'report') && !readConfig) noPrematureAction = false; // действие до чтения
        if (name === 'list_files') { messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(['app.log', 'readme.md', 'config.json']) }); continue; }
        if (name === 'read_file') { if (/config\.json/i.test(a.name || '')) readConfig = true; messages.push({ role: 'tool', tool_call_id: call.id, content: '{"debug": true, "port": 8080}' }); continue; }
        if (name === 'set_config') { if (!actedAlready) { actedAlready = true; terminalOk = /debug/i.test(a.key || '') && (a.value === false || a.value === 'false'); } messages.push({ role: 'tool', tool_call_id: call.id, content: 'ok' }); continue; }
        if (name === 'report') { if (!actedAlready) { actedAlready = true; terminalOk = false; } messages.push({ role: 'tool', tool_call_id: call.id, content: 'ok' }); continue; }
      }
      return ((readConfig ? 1 : 0) + (noPrematureAction ? 1 : 0) + (terminalOk ? 1 : 0)) / 3; // 3 под-проверки
    },
  },
  {
    id: 'instruction-hold', kind: 'удержание·длин.сессия', multiturn: true,
    // Правило на весь диалог: отвечать СТРОГО JSON {answer, n=номер вопроса}. Проверяем 5 ходов.
    async run() {
      const qs = ['Столица Франции?', 'Сколько будет 2+2?', 'Назови цвет неба днём.', 'Антоним слова «горячий»?', 'Сколько дней в неделе?'];
      const messages = [{ role: 'user', content: `Правило на ВЕСЬ диалог: на каждый мой вопрос отвечай СТРОГО в JSON {"answer": <строка-ответ>, "n": <номер моего вопроса, считая с 1>}. Никакого текста вне JSON. Первый вопрос: ${qs[0]}` }];
      let ok = 0;
      for (let i = 0; i < qs.length; i++) {
        if (i > 0) messages.push({ role: 'user', content: qs[i] });
        const m = await chat(messages, { max_tokens: 80 });
        messages.push({ role: 'assistant', content: m.content || '' });
        const j = firstJSON(m.content);
        if (j && typeof j.answer === 'string' && j.answer.length > 0 && Number(j.n) === i + 1) ok++;
      }
      return ok / qs.length; // доля ходов, где правило соблюдено
    },
  },
  {
    id: 'longctx-distract', kind: 'длинный контекст·дистр',
    // Две под-проверки: (1) выбрать нужный секрет среди похожих; (2) взять СВЕЖЕЕ значение после правки.
    async run() {
      const a = await chat([{ role: 'user', content: `Текст:\n${LONG}\nВопрос: какой код доступа именно у АДМИНА? Ответь одним числом.` }], { max_tokens: 20 });
      const q1 = nearNum(a.content, 999) && !nearNum(a.content, 111) && !nearNum(a.content, 555);
      const b = await chat([{ role: 'user', content: `Текст:\n${LONG}\nВопрос: какой порт у сервиса СЕЙЧАС (с учётом всех уточнений)? Ответь одним числом.` }], { max_tokens: 20 });
      const q2 = nearNum(b.content, 8090) && !nearNum(b.content, 8080);
      return ((q1 ? 1 : 0) + (q2 ? 1 : 0)) / 2;
    },
  },
  {
    id: 'subtle-bug', kind: 'код·тонкий баг',
    // Классический тонкий баг високосного года: наивное y%4===0. Починить по полному правилу.
    async run() {
      const m = await chat([{ role: 'user', content: 'Функция должна определять високосный год, но в ней тонкий баг:\n`const isLeap = y => y % 4 === 0`\nПравило: год високосный, если делится на 4, КРОМЕ вековых (делящихся на 100), но годы, делящиеся на 400, — високосные. Верни исправленную функцию isLeap. Только код.' }]);
      const fn = runCode(stripFence(m.content).replace(/^const\s+isLeap\s*=\s*/, 'var __f = ') + '\n', typeof stripFence(m.content).match(/isLeap/) ? 'isLeap' : '__f');
      const g = (typeof fn === 'function') ? fn : runCode(`${stripFence(m.content)}`, 'isLeap');
      if (typeof g !== 'function') return 0;
      const cases = [[2000, true], [1900, false], [2024, true], [2023, false], [2100, false]];
      let ok = 0; for (const [y, exp] of cases) { try { if (!!g(y) === exp) ok++; } catch {} }
      return ok / cases.length;
    },
  },
  {
    id: 'planning-topsort', kind: 'рассуждение·план',
    // Топосорт по описанным на русском зависимостям. Градуируем по доле удовлетворённых ограничений.
    async run() {
      const m = await chat([{ role: 'user', content: 'Этапы сборки KLAS и зависимости: «модель» должна идти до «сервер»; «сервер» — до «прокси»; «докер» — до «прокси». Всего 4 этапа: модель, сервер, прокси, докер. Выведи корректный порядок выполнения (топологическая сортировка). Ответь ТОЛЬКО названиями этапов через запятую.' }], { max_tokens: 60 });
      const t = (m.content || '').toLowerCase();
      const idx = (w) => t.indexOf(w);
      const has = ['модель', 'сервер', 'прокси', 'докер'].every((w) => idx(w) >= 0);
      const cons = [['модель', 'сервер'], ['сервер', 'прокси'], ['докер', 'прокси']];
      let ok = 0; for (const [a, b] of cons) { if (has && idx(a) < idx(b)) ok++; }
      return ok / cons.length; // доля соблюдённых ограничений (частичный балл за частичный порядок)
    },
  },
  {
    id: 'noisy-extract', kind: 'инструкции·извлеч',
    // Извлечь 4 поля из шумного русского текста. Градуируем по доле верных полей.
    async run() {
      const m = await chat([{ role: 'user', content: 'Из текста извлеки СТРОГО JSON без пояснений: {"service": string, "port": number, "severity": "low"|"medium"|"high", "restarted": boolean}. Текст: «Сегодня ночью сервис kiwix на порту 8081 внезапно упал, критичность высокая, дежурный инженер перезапустил его».' }], { max_tokens: 120 });
      const j = firstJSON(m.content); if (!j) return 0;
      let ok = 0;
      if (typeof j.service === 'string' && j.service.toLowerCase().includes('kiwix')) ok++;
      if (Number(j.port) === 8081) ok++;
      if (String(j.severity).toLowerCase() === 'high') ok++;
      if (j.restarted === true || j.restarted === 'true') ok++;
      return ok / 4;
    },
  },
  {
    id: 'acid-carryover', kind: 'кислотный·v2',
    // Перенос из v2: multistep-math (8.4) + json-sort. Средний балл двух под-задач.
    async run() {
      const a = await chat([{ role: 'user', content: 'У Криника 3 диска по 2 ТБ и 2 диска по 4 ТБ. Он заполнил 60% суммарного объёма. Сколько ТБ занято? Ответь одним числом.' }], { max_tokens: 200 });
      const q1 = nearNum(a.content, 8.4);
      const b = await chat([{ role: 'user', content: 'Сервисы KLAS: kiwix на 8081, homepage на 3005, caddy на 80. Верни СТРОГО JSON: {"count": number, "services": [{"name": string, "port": number}]} — массив отсортирован по port по возрастанию.' }], { max_tokens: 200 });
      let q2 = false; const j = firstJSON(b.content);
      if (j && j.count === 3 && Array.isArray(j.services)) q2 = String(j.services.map((s) => s.port)) === String([80, 3005, 8081]);
      return ((q1 ? 1 : 0) + (q2 ? 1 : 0)) / 2;
    },
  },
];

console.log(`\n═══ KLAS agent-bench v3 (градуированный) · модель: ${MODEL} · ${BASE} ═══`);
let total = 0;
for (const task of TASKS) {
  const t0 = Date.now();
  try {
    const score = await task.run();
    total += score;
    const bar = '█'.repeat(Math.round(score * 5)).padEnd(5, '░');
    console.log(`${bar} ${score.toFixed(2)}  ${task.id.padEnd(18)} [${task.kind}] ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.log(`░░░░░ 0.00  ${task.id.padEnd(18)} [${task.kind}] ОШИБКА: ${e.message.slice(0, 100)}`);
  }
}
console.log(`\nИтог v3 ${MODEL}: ${total.toFixed(1)} / ${TASKS.length}.0`);
