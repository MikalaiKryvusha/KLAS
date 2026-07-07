#!/usr/bin/env node
// tools/agent-bench-v2.mjs — агентный бенч KLAS, версия 2 (дифференцирующая).
// v1 (agent-bench.mjs) сатурирован: ВСЕ модели проходят 6/6 — «ум» не различить. v2 даёт задачи
// посложнее, где слабая модель спотыкается, а сильная — нет: многошаговое рассуждение, ЦЕПОЧКА
// вызовов инструментов (агентность), синтез по длинному контексту (2 иголки), строгий вложенный JSON
// с вычислением, точные форматные ограничения, отладка кода, честность (устойчивость к галлюцинациям).
// Каждая задача — pass/fail автопроверкой; проверки СТРОГИ по сути, но СНИСХОДИТЕЛЬНЫ к оформлению.
//
// Запуск: node tools/agent-bench-v2.mjs <model> [--base http://127.0.0.1:8080]
//         (модель — имя из llama-swap: gemma-4-12b | qwen3.5-35b | qwen3.6-27b | qwythos-9b | ornith-35b)
// Требует поднятый llama-swap/llama-server с OpenAI-совместимым API (--jinja для tool calling).

const MODEL = process.argv[2];
if (!MODEL) { console.error('Использование: node tools/agent-bench-v2.mjs <model> [--base URL]'); process.exit(1); }
const BASE = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'http://127.0.0.1:8080';

// --- утилиты ---
const cyr = (s) => (s.match(/[а-яё]/gi) || []).length;                 // счётчик кириллицы
const nums = (s) => (String(s).match(/-?\d+(?:[.,]\d+)?/g) || []).map((x) => parseFloat(x.replace(',', '.'))); // все числа
const nearNum = (s, target, eps = 0.05) => nums(s).some((v) => Math.abs(v - target) <= eps);
const stripFence = (s) => (s || '').replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();      // снять ``` ограждения

// низкоуровневый вызов модели; возвращает полное message (content и/или tool_calls)
async function chat(messages, { tools, max_tokens = 256, temperature = 0.1 } = {}) {
  const body = { model: MODEL, messages, max_tokens, temperature };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).choices[0].message;
}

// длинный контекст с ДВУМЯ иголками (в начале и в конце) для теста синтеза по контексту
const SECRET_A = 317, SECRET_B = 584;
const BLOCK = 'KLAS — локальная агентская ИИ-система на llama.cpp и llama-swap; владелец ценит стабильность, ум и скорость именно в этом порядке. ';
const TWO_NEEDLE = `СЕКРЕТ-A равен ${SECRET_A}. ` + BLOCK.repeat(120)
  + `Где-то здесь спрятан второй секрет. ` + BLOCK.repeat(120) + `СЕКРЕТ-B равен ${SECRET_B}. `;

// --- задачи v2: у каждой async run() → boolean (прошла ли) ---
const TASKS = [
  {
    id: 'multistep-math', kind: 'рассуждение',
    // многошаговый счёт: сначала общий объём, потом процент. Ответ 8.4.
    async run() {
      const m = await chat([{ role: 'user', content: 'У Криника 3 диска по 2 ТБ и 2 диска по 4 ТБ. Он заполнил 60% суммарного объёма. Сколько ТБ занято? Ответь одним числом.' }], { max_tokens: 200 });
      return nearNum(m.content, 8.4);       // 3*2+2*4=14; 60% = 8.4
    },
  },
  {
    id: 'order-reasoning', kind: 'рассуждение',
    // реляционное упорядочивание: A>B (быстрее), C<B, D>A ⇒ D,A,B,C
    async run() {
      const m = await chat([{ role: 'user', content: 'Модель A быстрее B. C медленнее B. D быстрее A. Расставь модели от самой быстрой к самой медленной. Ответь ТОЛЬКО буквами через запятую, например: X,Y,Z,W.' }], { max_tokens: 120 });
      const seq = (m.content || '').toUpperCase().match(/[ABCD]/g)?.join('') || '';
      return seq.startsWith('DABC');
    },
  },
  {
    id: 'nested-json-sort', kind: 'инструкции+JSON',
    // строгий вложенный JSON + сортировка по port по возрастанию + счётчик
    async run() {
      const m = await chat([{ role: 'user', content: 'Сервисы KLAS: kiwix на 8081, homepage на 3005, caddy на 80. Верни СТРОГО JSON без markdown и пояснений: {"count": number, "services": [{"name": string, "port": number}]} — массив отсортирован по port по возрастанию.' }], { max_tokens: 200 });
      try {
        const j = JSON.parse(stripFence(m.content));
        if (j.count !== 3 || !Array.isArray(j.services) || j.services.length !== 3) return false;
        const ports = j.services.map((s) => s.port);
        if (String(ports) !== String([80, 3005, 8081])) return false;      // порядок обязателен
        const names = j.services.map((s) => (s.name || '').toLowerCase());
        return names[0].includes('caddy') && names[1].includes('homepage') && names[2].includes('kiwix');
      } catch { return false; }
    },
  },
  {
    id: 'tool-chain', kind: 'агентность',
    // ЦЕПОЧКА: сначала проверить место (get_disk_free_gb), затем — раз мало — послать алерт (send_alert).
    async run() {
      const tools = [
        { type: 'function', function: { name: 'get_disk_free_gb', description: 'Свободное место на диске в ГБ', parameters: { type: 'object', properties: { disk: { type: 'string', description: 'Буква диска, напр. F' } }, required: ['disk'] } } },
        { type: 'function', function: { name: 'send_alert', description: 'Отправить текстовый алерт владельцу', parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } } },
      ];
      const messages = [
        { role: 'system', content: 'Ты агент KLAS. Используй инструменты пошагово: сначала узнай факт, потом действуй по условию. Не выдумывай данные.' },
        { role: 'user', content: 'Проверь свободное место на диске F, и ЕСЛИ его меньше 100 ГБ — отправь владельцу алерт об этом. Иначе ничего не отправляй.' },
      ];
      let calledDiskFirst = false;
      for (let round = 0; round < 4; round++) {
        const m = await chat(messages, { tools, max_tokens: 200 });
        const call = m.tool_calls?.[0];
        if (!call) return false;                          // должен работать инструментами
        messages.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });
        const name = call.function.name;
        let args = {}; try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
        if (round === 0) {                                // ПЕРВЫМ действием — проверка диска, не алерт
          if (name !== 'get_disk_free_gb' || !/f/i.test(args.disk || '')) return false;
          calledDiskFirst = true;
          messages.push({ role: 'tool', tool_call_id: call.id, content: '50' });   // отдаём: свободно 50 ГБ (<100)
          continue;
        }
        if (name === 'send_alert') return calledDiskFirst && typeof args.message === 'string' && args.message.length > 0;
        // любой другой инструмент вторым ходом — отвечаем и даём ещё шанс
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'ok' });
      }
      return false;
    },
  },
  {
    id: 'long-ctx-synth', kind: 'длинный контекст',
    // ДВЕ иголки далеко друг от друга → нужно найти обе и СЛОЖИТЬ. 317+584=901.
    async run() {
      const m = await chat([{ role: 'user', content: `Текст:\n${TWO_NEEDLE}\nВопрос: найди в тексте оба секретных числа (СЕКРЕТ-A и СЕКРЕТ-B) и ответь их СУММОЙ одним числом.` }], { max_tokens: 40 });
      return nearNum(m.content, SECRET_A + SECRET_B, 0.5);
    },
  },
  {
    id: 'code-edge', kind: 'код',
    // функция с краевыми случаями: неотрицательная разница дат в полных днях
    async run() {
      const m = await chat([{ role: 'user', content: "Напиши на JavaScript функцию daysBetween(a, b) — число ПОЛНЫХ дней между двумя датами формата 'YYYY-MM-DD', результат всегда неотрицательный. Верни ТОЛЬКО код функции." }], { max_tokens: 300 });
      try {
        const fn = new Function(`${stripFence(m.content)}; return daysBetween;`)();
        return fn('2024-01-01', '2024-01-02') === 1 && fn('2024-01-02', '2024-01-01') === 1 && fn('2024-03-01', '2024-03-01') === 0 && fn('2024-01-01', '2024-02-01') === 31;
      } catch { return false; }
    },
  },
  {
    id: 'debug-fix', kind: 'код',
    // найти и починить баг: должно суммировать ЧЁТНЫЕ, а фильтр берёт нечётные
    async run() {
      const m = await chat([{ role: 'user', content: 'Эта JS-функция должна возвращать сумму ЧЁТНЫХ чисел массива, но в ней баг:\n`const f = a => a.filter(x => x % 2).reduce((s, x) => s + x, 0)`\nВерни исправленную функцию f. Только код.' }], { max_tokens: 200 });
      try {
        const fn = new Function(`${stripFence(m.content).replace(/^const\s+f\s*=/, 'return ').replace(/;?\s*$/, '')}`)();
        return fn([1, 2, 3, 4]) === 6 && fn([1, 3, 5]) === 0 && fn([2, 4, 6]) === 12;
      } catch {
        // запасной путь: модель могла вернуть полное `const f = ...;`
        try { const code = stripFence(m.content); const fn = new Function(`${code}; return f;`)(); return fn([1, 2, 3, 4]) === 6 && fn([2, 4, 6]) === 12; } catch { return false; }
      }
    },
  },
  {
    id: 'strict-format', kind: 'точность формата',
    // жёсткое форматное ограничение: РОВНО 3 языка, строчными, по алфавиту, через запятую БЕЗ пробелов
    async run() {
      const m = await chat([{ role: 'user', content: 'Перечисли РОВНО три языка программирования по алфавиту, строчными буквами, через запятую без пробелов, и НИЧЕГО больше.' }], { max_tokens: 60 });
      const t = (m.content || '').trim();
      if (!/^[a-z+#]+(?:,[a-z+#]+){2}$/.test(t)) return false;      // 3 токена, без пробелов, без лишнего текста
      const parts = t.split(',');
      return String(parts) === String([...parts].sort());          // алфавитный порядок
    },
  },
  {
    id: 'honesty', kind: 'честность',
    // устойчивость к галлюцинациям: неизвестное знать нельзя — сильная модель ЧЕСТНО признаёт это
    async run() {
      const m = await chat([{ role: 'user', content: 'Сколько строк кода в приватном файле F:\\KLAS\\secret_xyz_нет_такого.mjs? Если этого знать нельзя — честно скажи об этом.' }], { max_tokens: 120 });
      const t = (m.content || '').toLowerCase();
      return /не могу|не знаю|невозможно|нет доступа|не име|не распол|не суще|cannot|don'?t know|no access/.test(t);
    },
  },
];

console.log(`\n═══ KLAS agent-bench v2 · модель: ${MODEL} · ${BASE} ═══`);
let passed = 0;
for (const task of TASKS) {
  const t0 = Date.now();
  try {
    const ok = await task.run();
    passed += ok;
    console.log(`${ok ? '✅' : '❌'} ${task.id.padEnd(16)} [${task.kind}] ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.log(`❌ ${task.id.padEnd(16)} [${task.kind}] ОШИБКА: ${e.message.slice(0, 120)}`);
  }
}
console.log(`\nИтог v2 ${MODEL}: ${passed}/${TASKS.length}`);
