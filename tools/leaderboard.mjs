#!/usr/bin/env node
// tools/leaderboard.mjs — свежие лидерборды открытых моделей с Hugging Face (идея 06/07).
// HF ведёт официальные бенчмарки с программным API; берём ранжированный список, обогащаем размером
// модели и датой релиза, фильтруем под наше железо (≤ N млрд параметров) — чтобы всегда знать
// ЛУЧШИЕ АКТУАЛЬНЫЕ открытые модели, которые реально влезут в 16 ГБ VRAM.
//
// Запуск:
//   node tools/leaderboard.mjs                         # SWE-bench Verified, модели ≤ 35B
//   node tools/leaderboard.mjs --bench cais/hle        # другой бенчмарк
//   node tools/leaderboard.mjs --max-params 32 --top 40
//   node tools/leaderboard.mjs --list                  # список официальных бенчмарков

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BENCH = arg('--bench', 'SWE-bench/SWE-bench_Verified');
const MAX_PARAMS = Number(arg('--max-params', '35'));   // млрд параметров (порог под 16 ГБ VRAM)
const TOP = Number(arg('--top', '40'));                 // сколько строк лидерборда просмотреть
const HF = 'https://huggingface.co/api';

// ⚠️ Сеть падает, и падать она обязана ВНЯТНО. Голый `await fetch` при обрыве роняет процесс
// стеком вызовов undici («TypeError: fetch failed … ConnectTimeoutError»), и слабая сессия по
// такому падению не понимает, что виновата не она и не лидерборд, а связь. Поймано 2026-08-01:
// разовый обрыв к huggingface, при том что сайт отвечал за 201 мс со второй попытки.
// Одна попытка повтора здесь уместна: обрыв соединения — событие мгновенное и часто одноразовое.
async function getJson(url, what) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      const why = e?.cause?.code || e?.message || String(e);
      if (attempt === 2) {
        console.error(`\n⛔ Не удалось получить ${what}: ${why}`);
        console.error(`   Адрес: ${url}`);
        console.error('   Это СЕТЬ, а не лидерборд: проверь связь (на этой машине уже мешали');
        console.error('   NordVPN и Tailscale одновременно) и повтори — обрыв часто одноразовый.\n');
        process.exit(1);
      }
      console.error(`  ⚠ ${what}: ${why} — повторяю`);
    }
  }
  return null;
}

if (process.argv.includes('--list')) {
  const ds = await getJson(`${HF}/datasets?filter=benchmark:official&limit=50`, 'список бенчмарков');
  console.log('Официальные бенчмарки HF:\n' + ds.map((d) => '  ' + d.id).join('\n'));
  process.exit(0);
}

console.log(`\n═══ Лидерборд: ${BENCH} · модели ≤ ${MAX_PARAMS}B · топ-${TOP} ═══\n`);
const board = await getJson(`${HF}/datasets/${BENCH}/leaderboard`, `лидерборд ${BENCH}`);
if (!Array.isArray(board)) { console.error('Неожиданный ответ API:', JSON.stringify(board).slice(0, 200)); process.exit(1); }

const fit = [];
for (const e of board.slice(0, TOP)) {
  const id = e.modelId;
  if (!id) continue;
  let params = null, created = null;
  try {
    const info = await (await fetch(`${HF}/models/${id}`)).json();
    if (info?.safetensors?.total) params = info.safetensors.total / 1e9;
    created = info?.createdAt ? info.createdAt.slice(0, 10) : null;
  } catch { /* нет метаданных — пропустим размер */ }
  // Оставляем только то, что влезает (или размер неизвестен — покажем со знаком ?)
  if (params === null || params <= MAX_PARAMS) {
    fit.push({ rank: e.rank, id, score: e.value, params, created });
  }
}

if (!fit.length) { console.log('Ничего не подошло под фильтр.'); process.exit(0); }
console.log('ранг | балл  | параметры | релиз      | модель');
console.log('-----+-------+-----------+------------+--------');
for (const m of fit) {
  const p = m.params === null ? '   ?    ' : `${m.params.toFixed(0).padStart(5)}B `;
  console.log(`#${String(m.rank).padStart(3)} | ${String(m.score).padStart(5)} | ${p} | ${m.created || '    ?     '} | ${m.id}`);
}
console.log(`\nПодошло ${fit.length}/${Math.min(TOP, board.length)} строк. Кандидата попробовать: node tools/try-model.mjs <repo-GGUF> <файл.gguf>`);
