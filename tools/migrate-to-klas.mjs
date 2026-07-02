#!/usr/bin/env node
// tools/migrate-to-klas.mjs — умная миграция системы из F:\LOCAL_NOMAD\ в F:\KLAS\ (рождение KLAS).
//
// Что делает (детали и манифест — plans/01_klas_migration.md):
//   1. Перемещает проект (local_ai_agent → корень F:\KLAS, вместе с .git-историей).
//   2. Перемещает нужную инфраструктуру (llamacpp, модели, docker-сервисы, mcp, nssm, tailscale).
//   3. Заменяет пути F:\LOCAL_NOMAD → F:\KLAS во всех текстовых файлах.
//   4. Комментирует блок anythingllm в docker-compose.yml (сервис остаётся в LOCAL_NOMAD).
//   5. Мигрирует «личность» Claude Code (память проекта + запись в ~/.claude.json), с бэкапами.
//   6. Ставит git remote origin = https://github.com/MikalaiKryvusha/KLAS.git.
//   7. Пишет отчёты MIGRATION_REPORT.md (в KLAS) и README_MOVED.md (в LOCAL_NOMAD).
//
// Запуск (владельцем): node tools/migrate-to-klas.mjs           ← DRY-RUN: только печатает план
//                      node tools/migrate-to-klas.mjs --apply   ← реальное выполнение
// Перед --apply: закрыть VS Code с проектом, остановить llama-server и docker.

import {
  existsSync, readdirSync, statSync, mkdirSync, renameSync, readFileSync,
  writeFileSync, cpSync, rmSync, copyFileSync,
} from 'node:fs';
import { join, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

// ── Константы миграции ──────────────────────────────────────────────────────
const SRC_ROOT = 'F:\\LOCAL_NOMAD';                 // старый дом
const SRC_PROJECT = join(SRC_ROOT, 'local_ai_agent'); // проект (уезжает в корень KLAS)
const DST = 'F:\\KLAS';                             // новый дом
const REPO_URL = 'https://github.com/MikalaiKryvusha/KLAS.git';

// Инфраструктура: что БЕРЁМ (пути относительно SRC_ROOT; имена сохраняются) — см. манифест плана 01
const TAKE = [
  'llamacpp',
  'LLMs\\LLAMACPP_MODELS',   // обе модели; Qwen — кандидат на ревизию в Фазе 2
  'docker-compose.yml',
  'kiwixdb',                 // база знаний (локальная википедия) — часть продукта KLAS
  'homepage',
  'caddy',
  'mcp',
  'nssm',
  'tailscale_funnel_443.bat',
];
// Что ОСТАВЛЯЕМ в LOCAL_NOMAD (устарело / сделаем иначе): AnythingLLM, LLMs\OLLAMA_MODELS, 1.txt

// Замена путей: любая буква регистра диска, оба разделителя; проект схлопывается в корень KLAS
const PATH_RX = /f:([\\/])LOCAL_NOMAD(?:\1local_ai_agent)?/gi; // → 'F:$1KLAS'

// Текстовые файлы для замены путей; бинарные/тяжёлые места пропускаем
const TEXT_EXT = new Set(['.md', '.bat', '.cmd', '.ps1', '.yml', '.yaml', '.json', '.mjs', '.js', '.txt']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'LLMs', 'kiwixdb']); // внутри llamacpp правим только bat\
const MAX_TEXT_SIZE = 5 * 1024 * 1024;

// Миграция Claude Code: папка проекта в ~/.claude/projects строится из cwd
const CLAUDE_DIR = join(homedir(), '.claude');
const OLD_SLUG = 'f--LOCAL-NOMAD-local-ai-agent';
const NEW_SLUGS = ['f--KLAS', 'F--KLAS']; // оба варианта регистра буквы диска — лишний безвреден

const APPLY = process.argv.includes('--apply');
const log = (m) => console.log(m);
const act = (m) => console.log(`${APPLY ? '▶' : '[dry-run]'} ${m}`);
const warnings = [];
const report = { moved: [], left: ['AnythingLLM', 'LLMs\\OLLAMA_MODELS', '1.txt'], rewritten: [] };

// ── Утилиты ────────────────────────────────────────────────────────────────
// Перемещение: rename на одном диске мгновенный; на другой диск/при блокировке — copy+delete
function moveItem(src, dst) {
  act(`move  ${src}  →  ${dst}`);
  if (!APPLY) return;
  mkdirSync(join(dst, '..'), { recursive: true });
  try {
    renameSync(src, dst);
  } catch {
    cpSync(src, dst, { recursive: true });
    rmSync(src, { recursive: true, force: true });
  }
}

// Рекурсивная замена путей в текстовых файлах
function rewritePaths(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      // внутри llamacpp интересна только bat\ (остальное — exe/dll)
      if (basename(dir) === 'llamacpp' && name !== 'bat') continue;
      rewritePaths(p);
    } else if ((TEXT_EXT.has(extname(name).toLowerCase()) || name === 'Caddyfile') && st.size <= MAX_TEXT_SIZE) {
      const before = readFileSync(p, 'utf8');
      const after = before.replace(PATH_RX, 'F:$1KLAS');
      if (after !== before) {
        act(`paths ${p}`);
        report.rewritten.push(p);
        if (APPLY) writeFileSync(p, after);
      }
    }
  }
}

// Комментирует блок сервиса в docker-compose.yml (сервис уровня 2 пробелов до следующего такого же)
function commentOutComposeService(composePath, service) {
  if (!existsSync(composePath)) return;
  const lines = readFileSync(composePath, 'utf8').split('\n');
  let inBlock = false, changed = false;
  const out = lines.map((line) => {
    if (new RegExp(`^  ${service}:`).test(line)) inBlock = true;
    else if (inBlock && /^  \S/.test(line)) inBlock = false; // следующий сервис того же уровня
    if (inBlock && line.trim() && !line.trim().startsWith('#')) { changed = true; return '# ' + line; }
    return line;
  });
  if (changed) {
    act(`comment out service "${service}" in ${composePath}`);
    if (APPLY) writeFileSync(composePath, `# Сервис ${service} закомментирован при миграции в KLAS (остался в F:\\LOCAL_NOMAD)\n` + out.join('\n'));
  }
}

// ── 1. Предпроверки ────────────────────────────────────────────────────────
log(`\n═══ Миграция LOCAL_NOMAD → KLAS ═══ режим: ${APPLY ? 'APPLY (реальное выполнение)' : 'DRY-RUN (репетиция, ничего не меняется)'}\n`);

if (!existsSync(join(SRC_PROJECT, '.kaif', 'kaif.json'))) {
  console.error(`✖ Источник не найден или это не KAIF-проект: ${SRC_PROJECT}`); process.exit(1);
}
// В F:\KLAS могут уже лежать собственные файлы владельца (логотип и т.п.) — это не помеха.
// Помеха только: чужой .git (мы приносим свою историю) и коллизии имён с тем, что переезжает.
if (existsSync(DST)) {
  const existing = readdirSync(DST);
  if (existing.includes('.git')) {
    console.error(`✖ В ${DST} уже есть .git — мы приносим свою git-историю. Убери его и запусти снова.`);
    process.exit(1);
  }
  const planned = new Set([
    ...readdirSync(SRC_PROJECT),
    ...TAKE.map((rel) => rel.split('\\')[0]),
    'MIGRATION_REPORT.md',
  ]);
  const collisions = existing.filter((name) => planned.has(name));
  if (collisions.length) {
    console.error(`✖ Коллизии имён в ${DST}: ${collisions.join(', ')} — убери/переименуй их и запусти снова.`);
    process.exit(1);
  }
  if (existing.length) log(`ℹ В ${DST} уже лежат файлы владельца (останутся как есть): ${existing.join(', ')}`);
}
// Предупреждения о запущенных процессах (файлы могут быть заблокированы)
try {
  const tl = execFileSync('tasklist', [], { encoding: 'utf8' });
  if (/llama-server\.exe/i.test(tl)) warnings.push('llama-server.exe запущен — останови его перед --apply');
} catch { /* tasklist недоступен — пропускаем проверку */ }
try {
  const dps = execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' }).trim();
  if (dps) warnings.push(`запущены docker-контейнеры (${dps.replace(/\n/g, ', ')}) — останови их перед --apply (docker compose down)`);
} catch { /* docker не запущен/не установлен — это нормально */ }
try {
  const dirty = execFileSync('git', ['-C', SRC_PROJECT, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (dirty) warnings.push('в проекте есть незакоммиченные изменения — лучше закоммитить перед --apply');
} catch { warnings.push('git недоступен — remote не будет настроен автоматически'); }
for (const w of warnings) log(`⚠ ${w}`);

// ── 2. Перемещение проекта в корень KLAS ───────────────────────────────────
log('\n— Проект → корень F:\\KLAS —');
if (APPLY) mkdirSync(DST, { recursive: true });
for (const name of readdirSync(SRC_PROJECT)) {
  moveItem(join(SRC_PROJECT, name), join(DST, name));
  report.moved.push(`local_ai_agent\\${name}`);
}
act(`rmdir ${SRC_PROJECT} (пустая оболочка)`);
if (APPLY) rmSync(SRC_PROJECT, { recursive: true, force: true });

// ── 3. Перемещение инфраструктуры по манифесту ─────────────────────────────
log('\n— Инфраструктура (манифест плана 01) —');
for (const rel of TAKE) {
  const src = join(SRC_ROOT, rel);
  if (!existsSync(src)) { warnings.push(`нет в источнике, пропущено: ${src}`); log(`⚠ пропуск: ${src} не существует`); continue; }
  moveItem(src, join(DST, rel));
  report.moved.push(rel);
}

// ── 4. Замена путей + правка docker-compose ────────────────────────────────
log('\n— Замена путей F:\\LOCAL_NOMAD → F:\\KLAS в текстовых файлах —');
if (APPLY) rewritePaths(DST);
else if (existsSync(SRC_PROJECT) || true) log('[dry-run] замена будет выполнена по всем текстовым файлам F:\\KLAS (список — в MIGRATION_REPORT.md)');
commentOutComposeService(join(APPLY ? DST : SRC_ROOT, 'docker-compose.yml'), 'anythingllm');

// ── 5. Миграция «личности» Claude Code ─────────────────────────────────────
log('\n— Claude Code: память проекта и ~/.claude.json —');
const oldProjDir = join(CLAUDE_DIR, 'projects', OLD_SLUG);
if (existsSync(oldProjDir)) {
  for (const slug of NEW_SLUGS) {
    const dst = join(CLAUDE_DIR, 'projects', slug);
    act(`copy  ${oldProjDir}  →  ${dst}  (оригинал остаётся как бэкап)`);
    if (APPLY) {
      cpSync(oldProjDir, dst, { recursive: true, force: true });
      // Пути обновляем только в markdown-памяти; jsonl-история — как есть (это архив)
      (function fixMd(dir) {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name);
          if (statSync(p).isDirectory()) fixMd(p);
          else if (name.endsWith('.md')) writeFileSync(p, readFileSync(p, 'utf8').replace(PATH_RX, 'F:$1KLAS'));
        }
      })(dst);
    }
  }
} else warnings.push(`память Claude Code не найдена: ${oldProjDir} — пропущено`);

const claudeJson = join(homedir(), '.claude.json');
if (existsSync(claudeJson)) {
  try {
    const cfg = JSON.parse(readFileSync(claudeJson, 'utf8'));
    const oldKey = Object.keys(cfg.projects ?? {}).find((k) => /^[fF]:\\LOCAL_NOMAD\\local_ai_agent$/.test(k));
    if (oldKey) {
      act(`~/.claude.json: клонировать запись проекта "${oldKey}" → "F:\\KLAS" и "f:\\KLAS" (бэкап: .claude.json.backup-klas)`);
      if (APPLY) {
        copyFileSync(claudeJson, claudeJson + '.backup-klas');
        for (const k of ['F:\\KLAS', 'f:\\KLAS']) cfg.projects[k] ??= structuredClone(cfg.projects[oldKey]);
        writeFileSync(claudeJson, JSON.stringify(cfg, null, 2));
      }
    } else warnings.push('~/.claude.json: запись проекта LOCAL_NOMAD\\local_ai_agent не найдена — пропущено');
  } catch (e) { warnings.push(`~/.claude.json: не удалось обработать (${e.message}) — пропущено`); }
}

// ── 6. Git remote ──────────────────────────────────────────────────────────
log('\n— Git remote —');
act(`git -C ${DST} remote add|set-url origin ${REPO_URL}`);
if (APPLY) {
  try {
    const remotes = execFileSync('git', ['-C', DST, 'remote'], { encoding: 'utf8' });
    execFileSync('git', ['-C', DST, 'remote', /\borigin\b/.test(remotes) ? 'set-url' : 'add', 'origin', REPO_URL]);
  } catch (e) { warnings.push(`git remote не настроен (${e.message}) — настрой вручную`); }
}

// ── 7. Отчёты ──────────────────────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);
const reportMd = `# MIGRATION_REPORT — LOCAL_NOMAD → KLAS (${today})

Скрипт: tools/migrate-to-klas.mjs (запущен владельцем). План/манифест: plans/01_klas_migration.md.

## Перемещено (${report.moved.length})
${report.moved.map((m) => `- ${m}`).join('\n')}

## Оставлено в F:\\LOCAL_NOMAD (устарело / сделаем иначе)
${report.left.map((m) => `- ${m}`).join('\n')}

## Файлы с заменой путей (${report.rewritten.length})
${report.rewritten.map((m) => `- ${m}`).join('\n') || '- (dry-run: замена не выполнялась)'}

## Предупреждения
${warnings.map((w) => `- ⚠ ${w}`).join('\n') || '- нет'}

## Следующие шаги (агенту в первой сессии в F:\\KLAS — чек-лист в plans/01_klas_migration.md)
1. npm run kaif:check · git status · git remote -v
2. Проверить замену путей (gemma4-12b.bat, docker-compose.yml, карты) и память Claude Code.
3. git push -u origin main
4. DONE-теги: ideas/01, plans/01; обновить STATUS.md; удалить этот отчёт после разбора (знание — в план).
`;
act(`write ${join(DST, 'MIGRATION_REPORT.md')}`);
if (APPLY) writeFileSync(join(DST, 'MIGRATION_REPORT.md'), reportMd);

act(`write ${join(SRC_ROOT, 'README_MOVED.md')}`);
if (APPLY) writeFileSync(join(SRC_ROOT, 'README_MOVED.md'),
  `# Система переехала (${today})\n\nВсё нужное перемещено в **F:\\KLAS** (KLAS — Krinik Local Agent System,\nhttps://github.com/MikalaiKryvusha/KLAS). Здесь остались только: AnythingLLM, LLMs\\OLLAMA_MODELS,\n1.txt (устаревшее / кандидаты на удаление — решение за владельцем).\n`);

// ── Итог ───────────────────────────────────────────────────────────────────
log(`\n═══ ${APPLY ? 'МИГРАЦИЯ ВЫПОЛНЕНА' : 'РЕПЕТИЦИЯ ЗАВЕРШЕНА (ничего не изменено)'} ═══`);
if (!APPLY) log('Если план устраивает: закрой VS Code с проектом, останови llama-server и docker, затем:\n  node F:\\LOCAL_NOMAD\\local_ai_agent\\tools\\migrate-to-klas.mjs --apply');
else log(`Открой VS Code в ${DST} и скажи агенту «продолжи» (/resume). Отчёт: ${join(DST, 'MIGRATION_REPORT.md')}`);
if (warnings.length) {
  log(`\nПредупреждения (${warnings.length}):`);
  for (const w of warnings) log(`  ⚠ ${w}`);
}
