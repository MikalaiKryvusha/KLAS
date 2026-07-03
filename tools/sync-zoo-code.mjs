#!/usr/bin/env node
// tools/sync-zoo-code.mjs — зеркалит скиллы KAIF в формат Zoo Code (адаптер из KAIF 1.2).
// Zoo Code (форк Cline→Roo→Zoo) читает слэш-команды из .roo/commands/<name>.md и авто-правила из
// .roo/rules/. Этот скрипт превращает .claude/skills/<name>/SKILL.md → .roo/commands/<name>.md
// (убирая строку `name:` — имя команды несёт имя файла) и пишет .roo/rules/kaif.md, чтобы Zoo Code
// АВТОМАТИЧЕСКИ подгружал канон проекта (лечит «модели забывают правила KAIF» — идея 07).
//
// Запуск: node tools/sync-zoo-code.mjs   (идемпотентно; перезаписывает команды из актуальных скиллов)

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(ROOT, '.claude', 'skills');
const CMDS = join(ROOT, '.roo', 'commands');
mkdirSync(CMDS, { recursive: true });
mkdirSync(join(ROOT, '.roo', 'rules'), { recursive: true });

let wrote = 0;
for (const name of readdirSync(SKILLS)) {
  const src = join(SKILLS, name, 'SKILL.md');
  if (!existsSync(src)) continue;
  // .roo/commands/<name>.md = содержимое SKILL.md без строки `name:` (имя команды = имя файла)
  const body = readFileSync(src, 'utf8').replace(/^name:[^\n]*\n/m, '');
  writeFileSync(join(CMDS, `${name}.md`), body);
  wrote++;
}

// Авто-правила: Zoo Code подгружает всё из .roo/rules/ в контекст каждой сессии.
writeFileSync(join(ROOT, '.roo', 'rules', 'kaif.md'),
  '# KAIF — правила проекта KLAS (автозагрузка Zoo Code)\n\n' +
  'Перед КАЖДОЙ задачей читай `AGENT_GUIDE.md` (канон проекта) и `STATUS.md` (текущее состояние); ' +
  'мысли по `PHILOSOPHY.md` (ПРОСТОТА: KISS + Оккам); чини баги по `BUG_FIXING_FRAMEWORK.md`.\n\n' +
  'Слэш-команды (навыки KAIF) живут в `.roo/commands/` — один `/command` на навык.\n');

console.log(`✔ Zoo Code sync: ${wrote} команд в .roo/commands/, .roo/rules/kaif.md обновлён`);
