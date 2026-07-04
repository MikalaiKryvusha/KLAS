#!/usr/bin/env node
// tools/install.mjs — УМНЫЙ МАСТЕР-УСТАНОВЩИК KLAS «под ключ» (план 05, идея 12).
//
// Уважительный, мультиязычный, устойчивый к перезагрузкам мастер: язык → детект железа →
// диагноз GPU-пути → вопросы → смета → установка по фазам (движок tools/deploy.mjs) → пост-настройка
// (ярлыки, автозапуск, health-check) → экран успеха. Прогресс в .deploy-state.json (resume).
//
// Запуск:
//   node tools/install.mjs                 ← интерактивный мастер
//   node tools/install.mjs --lang ru|en    ← без вопроса о языке
//   node tools/install.mjs --yes           ← без вопросов, рекомендуемые дефолты (foolproof)
//   node tools/install.mjs --detect-only   ← только детект окружения (JSON)
//   node tools/install.mjs --reset         ← забыть прогресс и начать заново

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { makeT, LANGS } from './lib/i18n.mjs';
import { select, confirm, multiselect, text, closePrompts, QuitSignal } from './lib/prompt.mjs';
import { detectEnvironment } from './lib/detect.mjs';
import { loadState, saveState, markDone, clearState, nextPhase } from './lib/state.mjs';
import { scheduleResumeAfterReboot } from './lib/resume.mjs';
import { fetchZimCatalog } from './lib/zim-catalog.mjs';
import { downloadFile } from './lib/download.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argVal = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const has = (f) => argv.includes(f);
const YES = has('--yes');

const line = (s = '') => console.log(s);
const yn = (t, v) => (v ? t('yes') : t('no'));
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'tools', 'deploy.manifest.json'), 'utf8'));

// Запуск дочернего процесса с выводом в консоль (движок, powershell-скрипты).
function runInherit(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false });
  return r.status === 0;
}

// ── Детект + печать таблицы окружения ────────────────────────────────────────
async function showDetection(t) {
  line(`\n${t('detect_title')}`);
  const env = await detectEnvironment(ROOT);
  const g = env.gpu;
  const rows = [
    [t('detect_gpu'), g.name || t('not_found')],
    [t('detect_vram'), g.vramGB ? `${g.vramGB} GB` : '—'],
    [t('detect_driver'), g.driver || t('not_found')],
    [t('detect_cuda'), g.cuda || t('not_found')],
    [t('detect_rocm'), g.rocm || t('not_found')],
    [t('detect_docker'), env.docker || t('not_found')],
    [t('detect_wsl'), yn(t, env.wsl)],
    [t('detect_node'), env.node],
    [t('detect_git'), env.git || t('not_found')],
    ['winget', env.winget || t('not_found')],
    [t('detect_disk'), env.freeDiskGB != null ? `${env.freeDiskGB} GB` : '—'],
    [t('detect_net'), yn(t, env.internet)],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [k, v] of rows) line(`  ${k.padEnd(w)} : ${v}`);
  return env;
}

function gpuVerdict(t, gpu) {
  if (gpu.vendor === 'nvidia') return { key: 'cuda', msg: t('gpu_nvidia') };
  if (gpu.vendor === 'amd') return { key: 'rocm', msg: t('gpu_amd') };
  return { key: 'cpu', msg: t('gpu_none') };
}

// Оценка объёма скачивания (ГБ) по выбранным элементам манифеста.
function estimateGB(items) {
  let bytes = 0;
  for (const name of items) {
    const it = MANIFEST.items[name];
    if (it?.check?.sizeBytes) bytes += it.check.sizeBytes;
    else if (name === 'llamacpp') bytes += 0.5e9; // движок + cudart ≈ 0.5 ГБ
  }
  return Math.max(1, Math.round(bytes / 1e9));
}

const humanGB = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} ГБ` : `${(b / 1e6).toFixed(0)} МБ`);
const ZIM_LANG = { ru: 'rus', en: 'eng' };

// Выбор баз знаний из живого каталога Kiwix (идея 12): понятный список — что есть, что содержит,
// сколько весит; пользователь отмечает нужные. Возвращает массив {url,file,sizeBytes,title}.
async function pickZims(t, lang) {
  if (!(await confirm(t('q_libs'), false))) return [];
  const query = await text(t('zim_search'), { def: '' });
  console.log(`\n${t('zim_fetching')}`);
  let list;
  try { list = await fetchZimCatalog({ lang: ZIM_LANG[lang] || 'eng', query: query || undefined, count: 40 }); }
  catch (e) { console.log(`  ⚠ ${e.message}`); return []; }
  if (!list.length) { console.log(`  ${t('zim_none')}`); return []; }
  const opts = list.map((z) => ({
    key: z.file,
    label: `${z.title} — ${humanGB(z.sizeBytes)} — ${z.lang}${z.articleCount ? ` — ${z.articleCount} ст.` : ''}`,
    z,
  }));
  const chosen = await multiselect(t('zim_pick'), opts);
  return chosen.map((k) => opts.find((o) => o.key === k).z);
}

async function askQuestions(t, env, state, lang) {
  const a = state.answers || {};
  if (YES) return { anonymous: false, model: 'main', zims: [], ...a };
  a.anonymous = await confirm(t('q_anonymous'), a.anonymous ?? false);
  a.model = await select(t('q_model'), [
    { key: 'main', label: t('model_main') },
    { key: 'backup', label: t('model_backup') },
    { key: 'both', label: t('model_both') },
  ], 0);
  a.zims = await pickZims(t, lang);
  return a;
}

// Список элементов манифеста под выбор пользователя.
function itemsFor(answers, env) {
  const models = answers.model === 'both'
    ? ['model-qwythos-9b', 'model-gemma-4-12b']
    : answers.model === 'backup' ? ['model-gemma-4-12b'] : ['model-qwythos-9b'];
  const items = ['llamacpp', ...models, 'llama-swap'];
  if (env.docker) items.push('docker-stack');
  return items;
}

async function main() {
  if (has('--reset')) clearState(ROOT);
  const state = loadState(ROOT);

  // Язык: аргумент → сохранённый → спросить (без флаг-эмодзи).
  let lang = argVal('--lang') || state.lang;
  if (!lang && !has('--detect-only') && !YES) {
    lang = await select(makeT('en')('lang_pick'),
      [{ key: 'ru', label: 'Русский' }, { key: 'en', label: 'English' }], 0);
  }
  lang = LANGS.includes(lang) ? lang : 'en';
  const t = makeT(lang);
  state.lang = lang;
  saveState(ROOT, state);
  markDone(ROOT, state, 'lang');

  if (has('--detect-only')) {
    console.log(JSON.stringify(await detectEnvironment(ROOT), null, 2));
    return;
  }

  line(`\n=== ${t('welcome_title')} ===`);
  line(t('welcome_body'));
  const cont = nextPhase(state);
  if (state.done.length > 1 && cont) line(`\n${t('resume_found', { phase: cont })}`);

  // ── Детект + диагноз GPU (Ф1/Ф2) ──
  const env = await showDetection(t);
  markDone(ROOT, state, 'detect');
  const verdict = gpuVerdict(t, env.gpu);
  line(`\n→ ${verdict.msg}`);
  if (verdict.key === 'cpu' && !YES) {
    if (!(await confirm(t('gpu_none_confirm'), false))) { line(`\n${t('bye')}`); return; }
  }
  // Ф2: GPU есть, но драйвер/рантайм не обнаружен → без него ускорение не заработает.
  // Драйвер надёжнее ставить с сайта вендора; ведём туда и предлагаем авто-продолжение после reboot.
  if (verdict.key !== 'cpu' && !env.gpu.driver && !env.gpu.cuda && !YES) {
    const vendor = env.gpu.vendor === 'nvidia' ? 'NVIDIA' : 'AMD';
    const url = env.gpu.vendor === 'nvidia' ? 'https://www.nvidia.com/download/index.aspx' : 'https://www.amd.com/support';
    line(`\n⚠ ${t('need_driver', { what: vendor })}`);
    line(`  ${t('driver_open', { url })}`);
    spawnSync('cmd', ['/c', 'start', '', url], { cwd: ROOT });
    if (await confirm(t('reboot_needed', { why: `${vendor} driver` }), true)) {
      if (scheduleResumeAfterReboot(ROOT, lang)) line(`  ${t('resume_scheduled')}`);
    }
    line(`\n${t('bye')}`);
    return;
  }
  markDone(ROOT, state, 'drivers');

  // Предохранители (защита от дурака): нет сети → стоп.
  if (!env.internet) { line(`\n⚠ ${t('no_internet')}`); return; }

  // ── Вопросы (Ф3) ──
  const answers = await askQuestions(t, env, state, lang);
  state.answers = answers;
  saveState(ROOT, state);
  markDone(ROOT, state, 'questions');

  // ── Смета + проверка места (включая выбранные базы знаний .zim) ──
  const items = itemsFor(answers, env);
  const zimBytes = (answers.zims || []).reduce((s, z) => s + z.sizeBytes, 0);
  const gb = estimateGB(items) + Math.round(zimBytes / 1e9);
  if (env.freeDiskGB != null && env.freeDiskGB < gb + 5) {
    line(`\n⚠ ${t('not_enough_disk', { need: gb + 5, free: env.freeDiskGB })}`);
    return;
  }
  const go = YES ? true : await confirm(t('estimate', { gb, disk: env.freeDiskGB ?? '?' }), true);
  if (!go) { line(`\n${t('bye')}`); return; }

  // ── Установка компонентов через движок deploy.mjs (Ф3) ──
  line(`\n${t('installing')}`);
  const deployOk = runInherit('node', [join(ROOT, 'tools', 'deploy.mjs'), '--apply', '--items', items.join(',')]);
  ['engine', 'model', 'docker', 'llama-swap'].forEach((p) => markDone(ROOT, state, p));

  // Базы знаний (.zim) из каталога Kiwix → kiwixdb/ (kiwix подхватит при подъёме стека).
  if ((answers.zims || []).length) {
    line(`\n${t('zim_downloading')}`);
    for (const z of answers.zims) {
      try { await downloadFile(z.url, join(ROOT, 'kiwixdb', z.file), z.title); }
      catch (e) { line(`  ⚠ ${z.file}: ${e.message}`); }
    }
  }

  // Анонимизация (если выбрана) — обезличить файлы проекта.
  if (answers.anonymous && existsSync(join(ROOT, 'tools', 'anonymize.mjs'))) {
    line(`\n${t('anonymizing')}`);
    runInherit('node', [join(ROOT, 'tools', 'anonymize.mjs')]);
  }

  // ── Пост-настройка (Ф4) ──
  line(`\n${t('making_shortcuts')}`);
  runInherit('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'tools', 'install-desktop-shortcuts.ps1')]);

  // Автозапуск при входе — только с согласия (persistence ставит пользователь, не молча).
  const wantAutostart = YES ? false : await confirm(t('offer_autostart'), false);
  if (wantAutostart && existsSync(join(ROOT, 'tools', 'install-autostart.ps1'))) {
    runInherit('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'tools', 'install-autostart.ps1')]);
  }

  // Поднять стек и проверить здоровье.
  line(`\n${t('running_health')}`);
  runInherit('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'tools', 'klas.ps1'), '-Action', 'up']);
  runInherit('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'tools', 'health-check.ps1')]);
  markDone(ROOT, state, 'post');

  // ── Экран успеха ──
  markDone(ROOT, state, 'done');
  line(`\n══════════════════════════════════════`);
  line(`  ${t('all_done_title')}`);
  line(`══════════════════════════════════════`);
  line(`  ${t('links_panel')}: http://localhost/`);
  line(`  ${t('links_chat')}:  http://localhost:3080/`);
  line(`  ${t('links_wiki')}:  http://localhost/wiki/`);
  line(`  ${t('where_password')}`);
  if (!deployOk) line(`\n⚠ Часть компонентов не установилась — см. вывод выше; повторный запуск дотянет недостающее.`);
  if (!YES && (await confirm(t('open_now'), true))) {
    spawnSync('cmd', ['/c', 'start', '', 'http://localhost/'], { cwd: ROOT });
  }
  clearState(ROOT); // успешный финал — прогресс больше не нужен
}

main()
  .then(() => closePrompts())
  .catch((e) => {
    closePrompts();
    if (e instanceof QuitSignal) { const t = makeT(loadState(ROOT).lang || 'en'); console.log(`\n${t('bye')}`); process.exit(0); }
    console.error(`\n✖ ${e.stack || e.message}`);
    process.exit(1);
  });
