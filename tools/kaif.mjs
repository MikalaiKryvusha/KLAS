#!/usr/bin/env node
// tools/kaif.mjs — маленький инструмент жизненного цикла KAIF (за npm-handles kaif:*).
// version — печатает маркер деплоя; check — валидирует развёрнутую структуру;
// остальные команды агентские (миграция/форк/удаление требуют суждения) — инструмент
// печатает, какой скилл вызвать у агента. Философия KAIF: процесс живёт в документах,
// которые читает агент; этот скрипт — лишь тонкая ручка к ним.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // корень проекта
const cmd = process.argv[2] ?? 'version';

// Читаем маркер деплоя — единственный источник правды о версии/сфере/агенте
function readMarker() {
  const p = join(ROOT, '.kaif', 'kaif.json');
  if (!existsSync(p)) {
    console.error('✖ .kaif/kaif.json не найден — KAIF здесь не развёрнут (или маркер потерян).');
    process.exit(1);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

if (cmd === 'version') {
  const m = readMarker();
  console.log(`KAIF v${m.version} (released ${m.released})`);
  console.log(`origin:   ${m.origin}`);
  console.log(`tracking: ${m.tracking} · sphere: ${m.sphere} · agent: ${m.agent} · language: ${m.language ?? 'en'}`);
} else if (cmd === 'check') {
  // Валидатор целостности: все ключевые документы, директории и скиллы на месте
  const m = readMarker();
  const docs = [
    'AGENT_GUIDE.md', 'PHILOSOPHY.md', 'BUG_FIXING_FRAMEWORK.md', 'GOAL.md',
    'STATUS.md', 'MASTER_PLAN.md', 'PROJECT_STRUCTURE_EXTERNAL_MAP.md',
    'PROJECT_ARCHITECTURE_INTERNAL_MAP.md', 'KAIF_FRAMEWORK.md', 'CLAUDE.md', 'AGENTS.md',
  ];
  const dirs = ['plans', 'ideas', 'bugs', 'researches', 'interviews', 'homeworks'];
  const skills = [
    'resume', 'pause', 'autoloop', 'dayloop', 'nightloop', 'refresh-context', 'check-backlog',
    'report-bug', 'bug-research', 'propose-idea', 'interview', 'revision', 'help-kaif', 'release',
    'kaif-version', 'kaif-update', 'kaif-fork', 'kaif-switch-origin', 'kaif-remove',
  ];
  let ok = true;
  const miss = (what) => { console.error(`✖ отсутствует: ${what}`); ok = false; };
  for (const d of docs) if (!existsSync(join(ROOT, d))) miss(d);
  for (const d of dirs) {
    if (!existsSync(join(ROOT, d))) miss(`${d}/`);
    else if (!existsSync(join(ROOT, d, 'README.md'))) miss(`${d}/README.md`);
  }
  for (const s of skills) if (!existsSync(join(ROOT, '.claude', 'skills', s, 'SKILL.md'))) miss(`.claude/skills/${s}/SKILL.md`);
  if (ok) console.log(`✔ KAIF v${m.version}: структура целостна (${docs.length} документов, ${dirs.length} директорий, ${skills.length} скиллов).`);
  else process.exit(1);
} else if (['update', 'fork', 'switch-origin', 'remove', 'remove-all'].includes(cmd)) {
  // Эти операции требуют суждения (миграция, merge, подтверждения владельца) — их ведёт агент
  const skill = cmd === 'remove-all' ? 'kaif-remove (режим: полное, --all)' : `kaif-${cmd}`;
  console.log(`Эта операция выполняется ИИ-агентом. Скажи своему агенту: «выполни /${skill.split(' ')[0]}»`);
  console.log(`Скилл: .claude/skills/${skill.split(' ')[0]}/SKILL.md`);
} else {
  console.error(`Неизвестная команда: ${cmd}. Доступно: version | check | update | fork | switch-origin | remove | remove-all`);
  process.exit(1);
}
