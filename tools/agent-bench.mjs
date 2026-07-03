#!/usr/bin/env node
// tools/agent-bench.mjs — агентный мини-бенч KLAS: меряем НЕ скорость, а пригодность модели к
// роли агента (Фаза 2b, researches/02): следование инструкциям, строгий JSON, вызов инструментов,
// русский язык, иголка в длинном контексте, исполнимый код. Каждая задача — pass/fail автопроверкой.
//
// Запуск: node tools/agent-bench.mjs <model>            ← модель из llama-swap (например gemma-4-12b)
//         node tools/agent-bench.mjs qwen3.5-35b --base http://127.0.0.1:8080
// Требует поднятый llama-swap (или llama-server) с OpenAI-совместимым API.

const MODEL = process.argv[2];
if (!MODEL) { console.error('Использование: node tools/agent-bench.mjs <model> [--base URL]'); process.exit(1); }
const BASE = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'http://127.0.0.1:8080';

const cyr = (s) => (s.match(/[а-яё]/gi) || []).length;           // счётчик кириллицы
const NEEDLE = 'ВЕРТОЛЁТ';                                        // секрет для needle-теста
const FILLER = ('KLAS — локальная агентская ИИ-система: llama.cpp, llama-swap, kiwix, харнесс и документы KAIF. Владелец ценит стабильность, ум и скорость — именно в этом порядке. ').repeat(220)
  + `Секретное слово этого документа: ${NEEDLE}. `
  + ('После секрета текст продолжается обычными повторами про стабильность, документы и харнесс KLAS. '.repeat(60));

// Задача: { id, суть запроса, параметры, check(message) → true/false }
const TASKS = [
  {
    id: 'instruction',   // точное следование инструкции
    messages: [{ role: 'user', content: 'Ответь РОВНО одним словом, без точки и пояснений: столица Беларуси?' }],
    max_tokens: 10,
    check: (m) => /^минск\.?$/i.test((m.content || '').trim()),
  },
  {
    id: 'strict-json',   // строгий JSON по схеме
    messages: [{ role: 'user', content: 'Верни СТРОГО JSON без markdown и пояснений: {"service": string, "port": number} — для сервиса kiwix, работающего на порту 8081.' }],
    max_tokens: 60,
    check: (m) => { try { const j = JSON.parse((m.content || '').trim()); return j.service?.toLowerCase().includes('kiwix') && j.port === 8081; } catch { return false; } },
  },
  {
    id: 'tool-call',     // нативный вызов инструмента (--jinja)
    messages: [{ role: 'user', content: 'Какая сейчас погода в Минске?' }],
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'Текущая погода в городе', parameters: { type: 'object', properties: { city: { type: 'string', description: 'Название города' } }, required: ['city'] } } }],
    max_tokens: 120,
    check: (m) => { const c = m.tool_calls?.[0]; if (!c || c.function.name !== 'get_weather') return false; try { return /минск|minsk/i.test(JSON.parse(c.function.arguments).city); } catch { return false; } },
  },
  {
    id: 'russian',       // качество русского: ответ по-русски, без огрызков разметки
    messages: [{ role: 'user', content: 'Объясни одним предложением по-русски, что делает команда git commit.' }],
    max_tokens: 80,
    check: (m) => { const t = (m.content || '').trim(); return cyr(t) > t.length * 0.5 && /коммит|фиксир|сохран|снимок|запис/i.test(t) && !/<\/?think|channel/i.test(t); },
  },
  {
    id: 'needle-16k',    // иголка в длинном контексте
    messages: [{ role: 'user', content: `Текст:\n${FILLER}\nВопрос: какое секретное слово указано в тексте? Ответь одним словом.` }],
    max_tokens: 15,
    check: (m) => (m.content || '').toUpperCase().includes(NEEDLE),
  },
  {
    id: 'runnable-code', // код, который реально исполняется
    messages: [{ role: 'user', content: 'Напиши на JavaScript функцию isPalindrome(s), игнорирующую регистр и пробелы. Верни ТОЛЬКО код функции, без markdown-ограждений и пояснений.' }],
    max_tokens: 200,
    check: (m) => {
      let code = (m.content || '').replace(/```(js|javascript)?/g, '').trim(); // прощаем ограждения
      try {
        const fn = new Function(`${code}; return isPalindrome;`)();
        return fn('А роза упала на лапу Азора') === true && fn('KLAS') === false && fn('Level') === true;
      } catch { return false; }
    },
  },
];

async function ask(task) {
  const body = { model: MODEL, messages: task.messages, max_tokens: task.max_tokens, temperature: 0.1 };
  if (task.tools) body.tools = task.tools;
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return { message: json.choices[0].message, secs: ((Date.now() - t0) / 1000).toFixed(1) };
}

console.log(`\n═══ KLAS agent-bench · модель: ${MODEL} · ${BASE} ═══`);
let passed = 0;
const rows = [];
for (const task of TASKS) {
  try {
    const { message, secs } = await ask(task);
    const ok = task.check(message);
    passed += ok;
    rows.push({ task: task.id, ok, secs });
    console.log(`${ok ? '✅' : '❌'} ${task.id.padEnd(14)} ${secs}s ${ok ? '' : '| ответ: ' + JSON.stringify(message.content ?? message.tool_calls).slice(0, 140)}`);
  } catch (e) {
    rows.push({ task: task.id, ok: false, secs: '-' });
    console.log(`❌ ${task.id.padEnd(14)} ОШИБКА: ${e.message.slice(0, 140)}`);
  }
}
console.log(`\nИтог ${MODEL}: ${passed}/${TASKS.length}`);
