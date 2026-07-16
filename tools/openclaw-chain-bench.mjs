#!/usr/bin/env node
// tools/openclaw-chain-bench.mjs — мини-бенч ЦЕПОЧЕК ИНСТРУМЕНТОВ в ЦИКЛЕ OPENCLAW (следствие смоука
// 2026-07-16, Q1 интервью 004). В отличие от agent-bench v2/v3 (наш цикл поверх /v1/chat/completions),
// здесь модель гоняется ВНУТРИ агентного цикла OpenClaw (embedded, `agent --local`) — меряем ровно то,
// что смоук пометил ⚠️: срезает ли модель шаги цепочки (write без read), держит ли ветвление и формат.
//
// Метод: фикстуры со СЛУЧАЙНЫМИ токенами кладутся в воркспейс пилота (~/.openclaw/workspace-pilot/bench/…)
// — токен нельзя угадать, поэтому правильное содержимое выходного файла ДОКАЗЫВАЕТ реальное чтение.
// Дополнительно смотрим meta.toolSummary из --json (сколько тул-коллов реально сделано).
// Оценка градуированная 0..1 на задачу (как v3), итог из 6.0.
//
// Запуск: node tools/openclaw-chain-bench.mjs <model> [--task <id>] [--keep]
//   <model> — id модели llama-swap (qwen3.5-35b | gemma-4-12b | …), подставляется как klas/<model>
//   --task  — прогнать одну задачу по id (отладка)
//   --keep  — не удалять фикстуры прогона (для разбора)
// Требует: llama-swap на 8080, openclaw (npm -g), профиль pilot (~/.openclaw-pilot/openclaw.json).
// Каждая задача идёт в СВЕЖЕЙ сессии (--session-key bench-<run>-<task>) — без кросс-контаминации.

import { spawnSync, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const MODEL = process.argv[2];
if (!MODEL) { console.error('Использование: node tools/openclaw-chain-bench.mjs <model> [--task id] [--keep]'); process.exit(1); }
const ONLY = process.argv.includes('--task') ? process.argv[process.argv.indexOf('--task') + 1] : null;
const KEEP = process.argv.includes('--keep');

// Воркспейс пилота OpenClaw — агент видит пути ОТНОСИТЕЛЬНО него
const WS = path.join(homedir(), '.openclaw', 'workspace-pilot');
if (!existsSync(WS)) { console.error(`Нет воркспейса пилота: ${WS} — сначала смоук-пилот (research 09 §3.4)`); process.exit(1); }

// Энтрипоинт openclaw запускаем НАПРЯМУЮ через node (без cmd-шелла: нет окон и проблем с кавычками/кириллицей)
const ENTRY = path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'openclaw', 'openclaw.mjs');
if (!existsSync(ENTRY)) { console.error(`Не найден openclaw: ${ENTRY}`); process.exit(1); }

const RUN = crypto.randomBytes(3).toString('hex');            // id прогона — отдельная папка фикстур
const BENCH_REL = `bench/${RUN}`;                             // относительный путь для промптов агенту
const BENCH_DIR = path.join(WS, 'bench', RUN);
const tok = (p) => `${p}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`; // неугадываемый токен
const norm = (s) => (s || '').replace(/\r\n/g, '\n').replace(/^﻿/, '').trim();
const readOut = (dir, name) => { const f = path.join(dir, name); return existsSync(f) ? norm(readFileSync(f, 'utf8')) : null; };

// Один ход агента OpenClaw в свежей сессии; возвращает { text, calls, tools, failures, durationMs } либо { error }
function agentRun(taskId, message) {
  const args = [ENTRY, '--profile', 'pilot', 'agent', '--local',
    '--model', `klas/${MODEL}`, '--session-key', `bench-${RUN}-${taskId}`,
    '--json', '--timeout', '300', '-m', message];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 360_000, windowsHide: true });
  const out = r.stdout || '';
  const at = out.search(/\{\s*[\r\n]+\s*"payloads"/);         // JSON идёт после строк-логов провайдера
  if (at < 0) return { error: `нет JSON в выводе (code=${r.status}): ${norm(out).slice(-200)} ${norm(r.stderr).slice(-200)}` };
  try {
    const j = JSON.parse(out.slice(at));
    const ts = j.meta?.toolSummary || {};
    return { text: j.payloads?.[0]?.text || '', calls: ts.calls ?? 0, tools: ts.tools || [], failures: ts.failures ?? 0, durationMs: j.meta?.durationMs ?? 0 };
  } catch (e) { return { error: `JSON не парсится: ${e.message}` }; }
}

// --- задачи: setup(dir) кладёт фикстуры и возвращает ctx; message(ctx) — промпт; grade(dir, ctx, res) → {score, notes} ---
const TASKS = [
  {
    id: 'copy-2', kind: 'цепочка-2: read→write',
    setup(dir) { const t = tok('SEC'); writeFileSync(path.join(dir, 'secret.txt'), t); return { t }; },
    message: (c, rel) => `Прочитай файл ${rel}/secret.txt и запиши его содержимое в новый файл ${rel}/out.txt, добавив в начало префикс "COPY:". Ничего не выдумывай — сначала реально прочитай файл.`,
    grade(dir, c, res) {
      const out = readOut(dir, 'out.txt'); let s = 0; const notes = [];
      if (out && out.includes(c.t)) s += 0.5; else notes.push('токен не перенесён (чтение срезано/выдумано)');
      if (out === `COPY:${c.t}`) s += 0.25; else notes.push('формат не точный');
      if (res.calls >= 2) s += 0.25; else notes.push(`тул-коллов ${res.calls} < 2`);
      return { score: s, notes };
    },
  },
  {
    id: 'branch-3', kind: 'цепочка+ветвление: read→решение→write',
    setup(dir) { const n = 100 + crypto.randomInt(900); writeFileSync(path.join(dir, 'num.txt'), String(n)); return { n }; },
    message: (c, rel) => `В файле ${rel}/num.txt записано целое число. Прочитай его. Если число ЧЁТНОЕ — запиши в ${rel}/verdict.txt строку "ЧЁТНОЕ:X", где X = число делённое на 2. Если НЕЧЁТНОЕ — запиши "НЕЧЁТНОЕ:X", где X = число умноженное на 3. Только одна строка, без пробелов вокруг двоеточия.`,
    grade(dir, c, res) {
      const out = readOut(dir, 'verdict.txt'); let s = 0; const notes = [];
      const even = c.n % 2 === 0, word = even ? 'ЧЁТНОЕ' : 'НЕЧЁТНОЕ', val = even ? c.n / 2 : c.n * 3;
      if (out && out.toUpperCase().startsWith(word)) s += 0.4; else notes.push(`ветка неверна (n=${c.n}, ждали ${word})`);
      if (out && out.includes(String(val))) s += 0.4; else notes.push(`арифметика неверна (ждали ${val}, есть "${out}")`);
      if (res.calls >= 2) s += 0.2; else notes.push(`тул-коллов ${res.calls} < 2`);
      return { score: s, notes };
    },
  },
  {
    id: 'merge-3', kind: 'цепочка-3: read+read→write',
    setup(dir) { const a = tok('ALFA'), b = tok('BRAVO'); writeFileSync(path.join(dir, 'a.txt'), a); writeFileSync(path.join(dir, 'b.txt'), b); return { a, b }; },
    message: (c, rel) => `Прочитай ОБА файла: ${rel}/a.txt и ${rel}/b.txt. Запиши в ${rel}/merged.txt одну строку строго в формате "A=<содержимое a.txt>;B=<содержимое b.txt>" (без пробелов). Сначала прочитай оба файла по-настоящему.`,
    grade(dir, c, res) {
      const out = readOut(dir, 'merged.txt'); let s = 0; const notes = [];
      if (out && out.includes(c.a)) s += 0.3; else notes.push('токен A потерян');
      if (out && out.includes(c.b)) s += 0.3; else notes.push('токен B потерян');
      if (out === `A=${c.a};B=${c.b}`) s += 0.2; else notes.push('формат не точный');
      if (res.calls >= 3) s += 0.2; else notes.push(`тул-коллов ${res.calls} < 3`);
      return { score: s, notes };
    },
  },
  {
    id: 'format-hold', kind: 'удержание формата: read→write по шаблону',
    setup(dir) { const name = tok('unit').toLowerCase(); writeFileSync(path.join(dir, 'name.txt'), name); return { name }; },
    message: (c, rel) => `Прочитай ${rel}/name.txt. Создай ${rel}/report.txt РОВНО из трёх строк:\nстрока 1: ОТЧЁТ\nстрока 2: содержимое name.txt В ВЕРХНЕМ РЕГИСТРЕ\nстрока 3: КОНЕЦ\nНикаких других строк, пустых строк и пояснений в файле быть не должно.`,
    grade(dir, c, res) {
      const out = readOut(dir, 'report.txt'); let s = 0; const notes = [];
      const lines = out ? out.split('\n').map((l) => l.trim()) : [];
      if (out && out.includes(c.name.toUpperCase())) s += 0.4; else notes.push('имя не перенесено/не в верхнем регистре');
      if (lines.length === 3) s += 0.3; else notes.push(`строк ${lines.length} ≠ 3`);
      if (lines[0] === 'ОТЧЁТ' && lines[2] === 'КОНЕЦ') s += 0.3; else notes.push('каркас ОТЧЁТ/КОНЕЦ нарушен');
      return { score: s, notes };
    },
  },
  {
    id: 'edit-keep', kind: 'точечная правка: read→edit без порчи соседних строк',
    setup(dir) {
      const keep1 = tok('K1'), keep3 = tok('K3'), keep4 = tok('K4');
      writeFileSync(path.join(dir, 'config.txt'), `${keep1}\nSTATUS=OLD\n${keep3}\n${keep4}`);
      return { keep1, keep3, keep4 };
    },
    message: (c, rel) => `В файле ${rel}/config.txt на второй строке замени STATUS=OLD на STATUS=NEW. Остальные строки НЕ трогай — они должны остаться ровно такими же. Правь тот же файл (не создавай новый).`,
    grade(dir, c, res) {
      const out = readOut(dir, 'config.txt'); let s = 0; const notes = [];
      const lines = out ? out.split('\n').map((l) => l.trim()) : [];
      if (lines[1] === 'STATUS=NEW') s += 0.4; else notes.push(`строка 2: "${lines[1]}"`);
      if (lines[0] === c.keep1 && lines[2] === c.keep3 && lines[3] === c.keep4) s += 0.4; else notes.push('соседние строки испорчены');
      if (lines.length === 4) s += 0.2; else notes.push(`строк ${lines.length} ≠ 4`);
      return { score: s, notes };
    },
  },
  {
    id: 'missing-honest', kind: 'честность: отсутствующий файл ≠ выдумка',
    setup() { return {}; },                                    // ghost.txt намеренно НЕ создаётся
    message: (c, rel) => `Прочитай файл ${rel}/ghost.txt и запиши его содержимое в ${rel}/ghost_out.txt. Если файла не существует — запиши в ${rel}/ghost_out.txt ровно строку "НЕТ ФАЙЛА" (без кавычек) и больше ничего.`,
    grade(dir, c, res) {
      const out = readOut(dir, 'ghost_out.txt'); const notes = [];
      if (out === 'НЕТ ФАЙЛА') return { score: 1, notes };
      if (out === null) { notes.push('выходной файл не создан'); return { score: 0.25, notes }; } // хотя бы не выдумал
      if (/НЕТ|не существует|not found|отсутств/i.test(out)) { notes.push(`формат вольный: "${out.slice(0, 60)}"`); return { score: 0.5, notes }; }
      notes.push(`похоже на выдумку: "${out.slice(0, 60)}"`); return { score: 0, notes };
    },
  },
];

// --- прогон ---
console.log(`\n=== openclaw-chain-bench · модель klas/${MODEL} · прогон ${RUN} ===`);
console.log(`(воркспейс: ${BENCH_DIR})\n`);
let total = 0; const rows = [];
for (const t of TASKS) {
  if (ONLY && t.id !== ONLY) continue;
  const dir = path.join(BENCH_DIR, t.id); mkdirSync(dir, { recursive: true });
  const ctx = t.setup(dir);
  const rel = `${BENCH_REL}/${t.id}`;
  const res = agentRun(t.id, t.message(ctx, rel));
  let score = 0, notes = [];
  if (res.error) { notes = [`ОШИБКА ХОДА: ${res.error}`]; }
  else ({ score, notes } = t.grade(dir, ctx, res));
  total += score;
  const secs = res.durationMs ? `${Math.round(res.durationMs / 1000)}с` : '—';
  rows.push({ id: t.id, kind: t.kind, score, tools: res.tools?.join('+') || '—', calls: res.calls ?? 0, secs, notes });
  console.log(`[${score.toFixed(2)}] ${t.id} (${t.kind}) · тулы: ${res.tools?.join('+') || '—'} (${res.calls ?? 0} коллов) · ${secs}${notes.length ? ` · ${notes.join('; ')}` : ''}`);
}
const max = ONLY ? 1 : TASKS.length;
console.log(`\nИТОГ klas/${MODEL}: ${total.toFixed(2)} / ${max}.0`);
// markdown-строка для таблицы в researches/09
console.log(`\n| ${MODEL} | ${rows.map((r) => r.score.toFixed(2)).join(' | ')} | **${total.toFixed(2)}/${max}.0** |`);
if (!KEEP) { rmSync(BENCH_DIR, { recursive: true, force: true }); console.log(`(фикстуры ${BENCH_REL} удалены; --keep чтобы оставить)`); }
