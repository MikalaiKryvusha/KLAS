#!/usr/bin/env node
// tools/install.mjs — УМНЫЙ МАСТЕР-УСТАНОВЩИК KLAS «под ключ» (план 05, идея 12).
//
// Уважительный, мультиязычный, устойчивый к перезагрузкам мастер: язык → детект железа →
// диагноз GPU-пути (CUDA/ROCm) → вопросы → установка по фазам с чекпоинтами → пост-настройка.
// Наращивается ПОВЕРХ движка tools/deploy.mjs (манифест/скачивание/идемпотентность).
//
// Запуск:
//   node tools/install.mjs                 ← интерактивный мастер
//   node tools/install.mjs --lang ru|en    ← без вопроса о языке
//   node tools/install.mjs --detect-only   ← только детект окружения (JSON), без интерактива
//   node tools/install.mjs --reset         ← забыть прогресс и начать заново
//
// Статус: ФАЗА 1 — фундамент (язык, детект, диагноз, план). Установки — в следующих фазах.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, LANGS } from './lib/i18n.mjs';
import { select, confirm, QuitSignal } from './lib/prompt.mjs';
import { detectEnvironment } from './lib/detect.mjs';
import { loadState, saveState, clearState, nextPhase } from './lib/state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argVal = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const has = (flag) => argv.includes(flag);

const line = (s = '') => console.log(s);
const yn = (t, v) => (v ? t('yes') : t('no'));

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

// GPU-путь по вендору (детали установки драйверов/рантайма — Фаза 2).
function gpuVerdict(t, gpu) {
  if (gpu.vendor === 'nvidia') return { key: 'cuda', msg: t('gpu_nvidia') };
  if (gpu.vendor === 'amd') return { key: 'rocm', msg: t('gpu_amd') };
  return { key: 'cpu', msg: t('gpu_none') };
}

async function main() {
  if (has('--reset')) clearState(ROOT);
  const state = loadState(ROOT);

  // Язык: аргумент → сохранённый → спросить (без флаг-эмодзи, только текст).
  let lang = argVal('--lang') || state.lang;
  const tmp = makeT(lang || 'en');
  if (!lang && !has('--detect-only')) {
    lang = await select(tmp('lang_pick'),
      [{ key: 'ru', label: 'Русский' }, { key: 'en', label: 'English' }], 0);
  }
  lang = LANGS.includes(lang) ? lang : 'en';
  const t = makeT(lang);
  state.lang = lang;
  saveState(ROOT, state);

  // Режим только-детект (для тестов/диагностики): печатаем JSON и выходим.
  if (has('--detect-only')) {
    const env = await detectEnvironment(ROOT);
    console.log(JSON.stringify(env, null, 2));
    return;
  }

  line(`\n=== ${t('welcome_title')} ===`);
  line(t('welcome_body'));
  const cont = nextPhase(state);
  if (state.done.length && cont) line(`\n${t('resume_found', { phase: cont })}`);

  const env = await showDetection(t);
  const verdict = gpuVerdict(t, env.gpu);
  line(`\n→ ${verdict.msg}`);
  if (verdict.key === 'cpu') {
    const go = await confirm(t('gpu_none_confirm'), false);
    if (!go) { line(`\n${t('bye')}`); return; }
  }

  // ── ФАЗА 1 завершается здесь: дальше (вопросы, драйверы, движок, модель, docker, пост) —
  //    Фазы 2–4 плана 05. Пока честно сообщаем, что фундамент готов.
  line('\n[Фаза 1] Фундамент мастера готов: язык, детект, диагноз GPU, чекпоинты.');
  line('Следующие фазы (вопросы → установка → пост-настройка) — в разработке (plans/05).');
  line(`${t('choose_hint')}`);
}

main().catch((e) => {
  if (e instanceof QuitSignal) { const t = makeT(loadState(ROOT).lang || 'en'); console.log(`\n${t('bye')}`); process.exit(0); }
  console.error(`\n✖ ${e.stack || e.message}`);
  process.exit(1);
});
