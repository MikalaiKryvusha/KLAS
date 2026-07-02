# KLAS — Krinik Local Agent System — контекст для ИИ-агентов

Универсальный входной файл для любой агентской системы (fallback-адаптер KAIF). Проект управляется
фреймворком **KAIF** (см. `KAIF_FRAMEWORK.md`).

**Перед каждой задачей читай канон проекта — `AGENT_GUIDE.md`** (правила, карта, команды, конвенции),
затем `STATUS.md` (текущее состояние, «где продолжить»). Мыслительный принцип — `PHILOSOPHY.md`
(ПРОСТОТА: KISS + Оккам); дефекты — по `BUG_FIXING_FRAMEWORK.md`.

Повторяемые ритуалы (скиллы) лежат в `.claude/skills/<name>/SKILL.md` — формат Claude Code, но
содержимое агент-агностично: если твоя система не открывает их как команды, читай нужный SKILL.md как
инструкцию и выполняй её. Основные: `resume` (старт сессии), `pause` (завершение), `autoloop`/
`dayloop`/`nightloop` (автономная работа), `report-bug`, `propose-idea`, `interview`, `revision`,
`check-backlog`, `refresh-context`, `help-kaif` и жизненный цикл `kaif-*`.

Рабочий язык проекта — русский.
