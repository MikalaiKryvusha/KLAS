#!/usr/bin/env node
// tools/cold-ttft.mjs — «сколько ждать первого токена, когда видеокарта пустая».
//
// ЗАЧЕМ. Наши прежние бенчи мерили ТЁПЛУЮ скорость (llama-bench: pp/tg на уже загруженной модели) и
// ум (agent-bench). Но llama-swap выгружает модель по ttl, и видеокарта у нас стоит пустой бо́льшую
// часть времени. Значит реальная скорость для человека — это время ОТ ЗАПРОСА ДО ПЕРВОГО ТОКЕНА
// на холодную: подъём llama-server + чтение весов с диска в VRAM + прогрев + prefill промпта.
// Критерий владельца, 2026-08-16: «от подачи запроса до первого токена — это важная метрика скорости».
//
// Запуск: node tools/cold-ttft.mjs <alias> [--prompt "текст"] [--runs 2] [--base http://127.0.0.1:8080]
// Пример: node tools/cold-ttft.mjs qwen3.8-27b
//
// Печатает три числа на каждый прогон:
//   TTFT холодный — пустой GPU → первый токен (то, что чувствует человек)
//   TTFT тёплый   — модель уже в VRAM → первый токен (чистый prefill)
//   цена загрузки — разность: сколько стоит именно подъём весов с диска

const args = process.argv.slice(2);
const alias = args.find((a) => !a.startsWith('--'));
if (!alias) { console.error('Использование: node tools/cold-ttft.mjs <alias> [--prompt "…"] [--runs N]'); process.exit(1); }

const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i === -1 ? def : args[i + 1]; };
const BASE = opt('base', 'http://127.0.0.1:8080');
const RUNS = Number(opt('runs', 2));
// Промпт намеренно ТРИВИАЛЬНЫЙ и короткий: мерим накладные расходы старта, а не работу модели.
const PROMPT = opt('prompt', 'Ответь одним словом: столица Франции?');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function unloadAndWait() {
  await fetch(`${BASE}/unload`).catch(() => {});
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${BASE}/running`).then((x) => x.json()).catch(() => null);
    if (r && Array.isArray(r.running) && r.running.length === 0) return true;
    await sleep(500);
  }
  return false;
}

// Один запрос со стримом: возвращает время до первого токена с содержимым, общее время и число чанков.
async function timeToFirstToken() {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: alias,
      messages: [{ role: 'user', content: PROMPT }],
      stream: true,
      max_tokens: 32,
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  let ttft = null, chunks = 0, text = '';
  const dec = new TextDecoder();
  let buf = '';
  for await (const part of res.body) {
    buf += dec.decode(part, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let j; try { j = JSON.parse(payload); } catch { continue; }
      const piece = j.choices?.[0]?.delta?.content ?? '';
      if (piece) { if (ttft === null) ttft = performance.now() - t0; chunks++; text += piece; }
    }
  }
  return { ttft, total: performance.now() - t0, chunks, text: text.trim() };
}

const fmt = (ms) => (ms === null ? '  —  ' : `${(ms / 1000).toFixed(2)} с`);

console.log(`\n⏱  Холодный TTFT — ${alias}`);
console.log(`   промпт: «${PROMPT}»  ·  ${RUNS} прогон(а)  ·  ${BASE}\n`);

const rows = [];
for (let run = 1; run <= RUNS; run++) {
  process.stdout.write(`  прогон ${run}: выгружаю всё… `);
  const empty = await unloadAndWait();
  if (!empty) console.log('⚠️ GPU не освободился за 30 с — число будет занижено');

  process.stdout.write('холодный… ');
  const cold = await timeToFirstToken();

  process.stdout.write('тёплый… ');
  const warm = await timeToFirstToken();

  rows.push({ run, cold, warm });
  console.log(`✓  ${fmt(cold.ttft)} / ${fmt(warm.ttft)}`);
  if (run === 1) console.log(`     ответ модели: «${cold.text.slice(0, 60)}»`);
}

console.log('\n┌─ результат ─────────────────────────────────────────────────────────┐');
console.log('│ прогон │ TTFT холодный │ TTFT тёплый │ цена загрузки весов          │');
for (const r of rows) {
  const price = r.cold.ttft !== null && r.warm.ttft !== null ? fmt(r.cold.ttft - r.warm.ttft) : '  —  ';
  console.log(`│   ${String(r.run).padEnd(4)} │  ${fmt(r.cold.ttft).padEnd(11)} │ ${fmt(r.warm.ttft).padEnd(11)} │ ${price.padEnd(28)} │`);
}
console.log('└─────────────────────────────────────────────────────────────────────┘');

const colds = rows.map((r) => r.cold.ttft).filter((x) => x !== null);
if (colds.length) {
  const med = colds.slice().sort((a, b) => a - b)[Math.floor(colds.length / 2)];
  console.log(`\nмедиана холодного TTFT: ${fmt(med)}   ← число для сравнения моделей`);
}
