// tools/lib/state.mjs — чекпоинты мастера (план 05): устойчивость к прерываниям и перезагрузкам.
// Хранит выбранный язык, ответы пользователя и завершённые фазы в .deploy-state.json (вне git).
// При старте мастер читает состояние и продолжает с незавершённой фазы.

import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Порядок фаз установки — источник правды для «где продолжить».
export const PHASES = ['lang', 'detect', 'questions', 'drivers', 'engine', 'model', 'docker', 'llama-swap', 'post', 'done'];

export function stateFile(root) {
  return join(root, '.deploy-state.json');
}

export function loadState(root) {
  const f = stateFile(root);
  if (!existsSync(f)) return { lang: null, answers: {}, done: [] };
  try { return JSON.parse(readFileSync(f, 'utf8')); }
  catch { return { lang: null, answers: {}, done: [] }; }
}

export function saveState(root, state) {
  writeFileSync(stateFile(root), JSON.stringify(state, null, 2), 'utf8');
}

// Отметить фазу выполненной и сохранить.
export function markDone(root, state, phase) {
  if (!state.done.includes(phase)) state.done.push(phase);
  saveState(root, state);
}

// Первая незавершённая фаза (куда продолжать). null → всё сделано.
export function nextPhase(state) {
  return PHASES.find((p) => !state.done.includes(p)) || null;
}

// Сброс состояния (успешный финал или явный reset).
export function clearState(root) {
  const f = stateFile(root);
  if (existsSync(f)) rmSync(f);
}
