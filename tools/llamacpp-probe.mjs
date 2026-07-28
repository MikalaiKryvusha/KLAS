#!/usr/bin/env node
/**
 * llamacpp-probe.mjs — СТЕНД для проверки билда llama.cpp настоящим потребителем (ядром OpenClaw).
 *
 * Зачем: обновление движка нельзя проверять curl-ом — у агентного ядра набор схем инструментов
 * несопоставимо сложнее, и ломается именно он (EXPERIENCE.md EXP-0006, bugs/05). Скрипт делает
 * ровно то, что в прошлой сессии делалось руками, но за один шаг и без риска для боевого стека:
 *
 *   1. качает нужный билд с GitHub (ассет llama-<build>-bin-win-cuda-13.3-x64.zip, ~150 МБ) и
 *      распаковывает его в llamacpp-probe\<build>\; CUDA-runtime DLL (390 МБ) НЕ качает, а копирует
 *      из уже лежащей на диске сборки-донора — они одинаковы для всех релизов cuda-13.3;
 *   2. поднимает llama-server на ОТДЕЛЬНОМ порту 5900 (боевой стек на 8080 не трогается), без окна,
 *      stderr движка — в файл: именно там движок печатает грамматику и строку, на которой упал
 *      (EXP-0008);
 *   3. временно уводит baseUrl провайдера klas в ~/.openclaw/openclaw.json на стенд и делает
 *      НАСТОЯЩИЙ ход ядра (без --model — иначе выключается цепочка fallback, EXP-0005);
 *   4. восстанавливает конфиг, гасит стенд, печатает вердикт и дописывает строку в журнал бисекции.
 *
 * Запуск:
 *   node tools/llamacpp-probe.mjs b9960              # критерий (а): ход ядра «привет» не падает 400
 *   node tools/llamacpp-probe.mjs b9960 --ui         # критерий (б): живой UI-тест (plans/16 фаза 4)
 *   node tools/llamacpp-probe.mjs b9960 --download   # только скачать/распаковать, не запускать
 *
 * ⚠️ Ест GPU (грузит основную модель ~12.7 ГБ VRAM) — запускать на свободной видеокарте.
 * ⚠️ --ui физически двигает мышь и клавиатуру (Windows-MCP): только под присмотром.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = 'F:\\KLAS';
const PROBE_DIR = path.join(ROOT, 'llamacpp-probe');
// Донор CUDA-runtime: любая уже распакованная сборка cuda-13.3 (эти DLL байт-в-байт одни и те же
// во всех релизах — ассет cudart-llama-bin-win-cuda-13.3-x64.zip имеет постоянный размер).
const CUDA_DONOR = path.join(ROOT, 'llamacpp-b10167');
const CUDA_DLLS = ['cublas64_13.dll', 'cublasLt64_13.dll', 'cudart64_13.dll'];
const MODEL = path.join(ROOT, 'LLMs', 'LLAMACPP_MODELS', 'Qwen3.6-35B-A3B-UD-IQ3_S.gguf');
const OPENCLAW_CFG = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const OPENCLAW_ENTRY = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs');
const LOG_TSV = path.join(PROBE_DIR, 'bisect-log.tsv');

const PORT = 5900;                    // стендовый порт: боевой llama-swap живёт на 8080
const STAND_BASE_URL = `http://127.0.0.1:${PORT}/v1`;
const HEALTH_TIMEOUT_MS = 300_000;    // холодная загрузка 12.7 ГБ модели с диска
const TURN_TIMEOUT_MS = 240_000;      // один ход ядра (тёплый — 15–25 с, но MCP-старт добавляет)

// Аргументы стенда — зеркало боевого профиля qwen3.6 из llama-swap/config.yaml, чтобы проверять
// то же самое, что пойдёт в бой (контекст, KV q8_0, сэмплинг Qwen non-thinking, --jinja).
const SERVER_ARGS = [
  '-m', MODEL,
  '--port', String(PORT),
  '-c', '98304', '-ctk', 'q8_0', '-ctv', 'q8_0',
  '-ngl', '99', '--flash-attn', 'on', '-b', '2048', '-ub', '1024', '--jinja',
  '-np', '1', '--slots', '--cont-batching',
  '--temperature', '0.7', '--top-p', '0.8', '--top-k', '20', '--min-p', '0',
  '--chat-template-kwargs', '{"enable_thinking": false}',
];

// Критерий (а) — самый дешёвый ход ядра. На битой грамматике падает за 0.2–0.5 с.
const PROMPT_HELLO = 'привет';

// Критерий (б) — живой UI-тест из plans/16 фаза 4 (правки этой строки — только вместе с планом).
// Поправка 2026-07-28: у нового Блокнота Windows 11 область ввода НЕ отдаётся в UIA (нет метки) —
// проверено живым прогоном. Поэтому шаг 4 идёт вторым путём тула Type: `loc` = координаты внутри
// клиентской области окна (Type принимает либо label, либо loc — см. Windows-MCP tools/input.py).
// Поправка 2026-07-28 (вечер): печатаемый текст несёт УНИКАЛЬНЫЙ токен прогона. Без него тест мог
// пройти по НЕВЕРНОЙ причине: Блокнот Windows 11 хранит несохранённую вкладку между запусками, и в
// редакторе уже лежал текст от прошлого прогона — «KLAS UIA test на экране» выполнялось само собой.
// Токен же сверяется машинно (см. notepadTitles) — по состоянию ОС, а не по самоотчёту модели.
const uiToken = () => `K${randomBytes(3).toString('hex').toUpperCase()}`;
const promptUi = (token) => `Use ONLY the windows MCP tools. This Windows is Russian: the Notepad window is titled Блокнот. Rule A: numbers in parentheses like (659,2100) are SCREEN COORDINATES, never labels. Rule B: never switch to any application whose name contains ++ or Code or Visual. Step 1. App with mode launch_executable and executable C:\\Windows\\System32\\notepad.exe . Step 2. Wait 3 seconds, then Snapshot with use_ui_tree true and find the Notepad window bounding box. Step 3. Type the text KLAS UIA ${token} into the Notepad editing area. The editor may already contain leftover text from an earlier run — that is fine, just append. The modern Notepad does NOT expose its editing area in the UI tree, so do NOT look for a label: call Type with the loc parameter set to screen coordinates near the centre of the Notepad window client area (below the toolbar), for example loc [x, y] where x is the horizontal centre of the window and y is about 150 pixels below the toolbar. Step 4. Take a Screenshot and report whether the text KLAS UIA ${token} is visible in the Notepad window, plus the exact loc you typed at.`;

const log = (...a) => console.log(...a);

/** Синхронный вызов утилиты с выводом в консоль (gh, powershell, taskkill). */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/** Шаг 1 — билд на диске (скачать + распаковать + доложить CUDA-runtime). */
function ensureBuild(tag) {
  const dir = path.join(PROBE_DIR, tag);
  const exe = path.join(dir, 'llama-server.exe');
  if (!fs.existsSync(exe)) {
    fs.mkdirSync(dir, { recursive: true });
    const asset = `llama-${tag}-bin-win-cuda-13.3-x64.zip`;
    const zip = path.join(dir, asset);
    if (!fs.existsSync(zip)) {
      log(`⬇  качаю ${asset} …`);
      const dl = run('gh', ['release', 'download', tag, '-R', 'ggml-org/llama.cpp', '-p', asset, '-D', dir, '--clobber'], { shell: true });
      if (dl.code !== 0) throw new Error(`gh release download ${tag} упал: ${dl.out.trim()}`);
    }
    log('📦 распаковываю …');
    const ex = run('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`]);
    if (ex.code !== 0) throw new Error(`Expand-Archive упал: ${ex.out.trim()}`);
    fs.rmSync(zip, { force: true });
    // некоторые релизы кладут бинари в подпапку — поднимаем их наверх
    if (!fs.existsSync(exe)) {
      const sub = fs.readdirSync(dir).map((n) => path.join(dir, n))
        .find((p) => fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'llama-server.exe')));
      if (!sub) throw new Error(`в ${dir} нет llama-server.exe после распаковки`);
      for (const n of fs.readdirSync(sub)) fs.renameSync(path.join(sub, n), path.join(dir, n));
      fs.rmSync(sub, { recursive: true, force: true });
    }
  }
  for (const dll of CUDA_DLLS) {
    const dst = path.join(dir, dll);
    if (!fs.existsSync(dst)) fs.copyFileSync(path.join(CUDA_DONOR, dll), dst);
  }
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health(port = PORT) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

/** Ждём, пока стенд прогрузит модель; параллельно следим, что процесс жив. */
async function waitHealth(child, errPath) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await health()) return true;
    if (child.exitCode !== null) {
      const tail = fs.existsSync(errPath) ? fs.readFileSync(errPath, 'utf8').split('\n').slice(-15).join('\n') : '';
      throw new Error(`llama-server умер (код ${child.exitCode}) до готовности:\n${tail}`);
    }
    await sleep(2000);
  }
  throw new Error(`стенд не поднялся за ${HEALTH_TIMEOUT_MS / 1000} с`);
}

/** Временная подмена baseUrl провайдера klas: ядро ходит на стенд, а не в боевой llama-swap. */
function setBaseUrl(url) {
  const raw = fs.readFileSync(OPENCLAW_CFG, 'utf8');
  const cfg = JSON.parse(raw);
  const prev = cfg.models.providers.klas.baseUrl;
  cfg.models.providers.klas.baseUrl = url;
  fs.writeFileSync(OPENCLAW_CFG, JSON.stringify(cfg, null, 2), 'utf8');
  return prev;
}

/** Настоящий ход ядра. Никакого --model: явный флаг обнуляет цепочку fallback (EXP-0005). */
function runTurn(prompt, sessionKey) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [OPENCLAW_ENTRY, 'agent', '--local', '--session-key', sessionKey, '-m', prompt],
    { encoding: 'utf8', timeout: TURN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), ms: Date.now() - t0 };
}

function killTree(pid) {
  if (pid) run('taskkill', ['/PID', String(pid), '/T', '/F']);
}

/**
 * Машинная сверка результата UI-теста: заголовки всех окон Блокнота.
 * Windows держит в заголовке имя вкладки, а для несохранённой вкладки оно берётся из её содержимого,
 * — значит напечатанный текст виден из ОС. Судим по нему, а НЕ по самоотчёту модели: модель охотно
 * рапортует «SUCCESS» (EXP-0010), и ровно так тест однажды «прошёл» на чужом тексте.
 */
function notepadTitles() {
  const r = run('powershell', ['-NoProfile', '-Command',
    "(Get-Process notepad -ErrorAction SilentlyContinue | ForEach-Object { $_.MainWindowTitle }) -join ' | '"]);
  return (r.out || '').trim();
}

async function main() {
  const args = process.argv.slice(2);
  const tag = args.find((a) => /^b\d+$/.test(a));
  if (!tag) { console.error('нужен билд, например: node tools/llamacpp-probe.mjs b9960 [--ui] [--download]'); process.exit(2); }
  const uiMode = args.includes('--ui');
  const downloadOnly = args.includes('--download');

  fs.mkdirSync(PROBE_DIR, { recursive: true });
  const dir = ensureBuild(tag);
  log(`✔  билд ${tag} готов: ${dir}`);
  if (downloadOnly) return;

  if (await health()) throw new Error(`порт ${PORT} уже занят — на нём висит чужой/прошлый стенд, прибери его`);

  const errPath = path.join(dir, 'stand-stderr.txt');
  const errFd = fs.openSync(errPath, 'w');
  const child = spawn(path.join(dir, 'llama-server.exe'), SERVER_ARGS,
    { windowsHide: true, stdio: ['ignore', errFd, errFd], detached: false });
  log(`▶  стенд ${tag} поднимается на :${PORT} (pid ${child.pid}), stderr → ${errPath}`);

  let prevUrl = null;
  const cleanup = () => {
    if (prevUrl) { try { setBaseUrl(prevUrl); } catch {} prevUrl = null; }
    killTree(child.pid);
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  let verdict = 'ERROR', evidence = '', ms = 0;
  try {
    const t0 = Date.now();
    await waitHealth(child, errPath);
    log(`✔  модель загружена за ${((Date.now() - t0) / 1000).toFixed(0)} с`);

    prevUrl = setBaseUrl(STAND_BASE_URL);
    const token = uiMode ? uiToken() : '';
    if (uiMode) log(`ℹ  токен прогона: ${token} — по нему сверяется результат (bugs/07)`);
    const turn = runTurn(uiMode ? promptUi(token) : PROMPT_HELLO, `probe-${tag}${uiMode ? '-ui' : ''}`);
    ms = turn.ms;
    setBaseUrl(prevUrl); prevUrl = null;

    const stderrText = fs.existsSync(errPath) ? fs.readFileSync(errPath, 'utf8') : '';
    const grammarBroken = /failed to parse grammar/i.test(stderrText) || /failed to parse grammar/i.test(turn.out);

    if (grammarBroken) {
      verdict = 'FAIL-GRAMMAR';
      const bad = stderrText.split('\n').filter((l) => /::=|failed to parse grammar/.test(l)).slice(-6);
      evidence = bad.join(' | ').slice(0, 400);
    } else if (turn.code !== 0) {
      verdict = 'FAIL-TURN';
      evidence = turn.out.split('\n').filter(Boolean).slice(-6).join(' | ').slice(0, 400);
    } else if (uiMode) {
      // Ход завершился успешно — но «успешно» говорит модель. Спрашиваем ОС.
      const titles = notepadTitles();
      if (titles.includes(token)) {
        verdict = 'PASS';
        evidence = `токен ${token} найден в заголовке Блокнота: ${titles}`.slice(0, 400);
      } else {
        verdict = 'FAIL-UI-UNVERIFIED';
        evidence = `ход прошёл, но токена ${token} в Блокноте НЕТ (заголовки: ${titles || 'окон нет'})`.slice(0, 400);
      }
    } else {
      verdict = 'PASS';
      evidence = turn.out.split('\n').filter((l) => l.trim()).slice(-3).join(' | ').slice(0, 400);
    }
    log(`\n───── ход ядра (${(ms / 1000).toFixed(1)} с, код ${turn.code}) ─────`);
    log(turn.out.split('\n').slice(-40).join('\n'));
  } catch (e) {
    evidence = String(e.message).slice(0, 400);
  } finally {
    cleanup();
  }

  const row = [new Date().toISOString(), tag, uiMode ? 'ui' : 'hello', verdict, `${(ms / 1000).toFixed(1)}s`, evidence.replace(/\t/g, ' ')].join('\t');
  fs.appendFileSync(LOG_TSV, row + '\n', 'utf8');
  log(`\n══ ${tag} · ${uiMode ? 'критерий (б) UI' : 'критерий (а) ход ядра'} → ${verdict}`);
  if (evidence) log(`   улика: ${evidence}`);
  process.exit(verdict === 'PASS' ? 0 : 1);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
