# openclaw/ — конфигурация агентного ядра ассистента KLAS

**OpenClaw — принятое ядро ассистента** (решение владельца 2026-07-17, Q1 интервью 004; данные —
`researches/09_oss_constructor_map.md` §3.4). Выкат ступенями — `plans/10_openclaw_core_rollout.md`.

- `openclaw.json.example` — шаблон рабочего конфига. Живёт в git; рабочая копия — вне git, в
  `~/.openclaw/openclaw.json` (профиль по умолчанию). Развёртывание: `npm i -g openclaw`, скопировать
  шаблон в `~/.openclaw/openclaw.json`, проверить `openclaw config validate`.
- Ключевое в конфиге: провайдер `klas` → llama-swap `127.0.0.1:8080/v1`; у КАЖДОЙ модели обязателен
  `compat.unsupportedToolSchemaKeywords: ["pattern"]` (иначе llama.cpp 400 на схемах инструментов);
  fallback №1 — `qwen3.5-35b-r` (алиас того же инстанса в `llama-swap/config.yaml` = ретрай той же
  модели при флейковой 500 peg-парсера тул-коллов, llama.cpp #20260); exec зажат
  (`tools.exec.mode: allowlist`, `ask: off`) — ступень 0 полномочий (Q4 интервью 004).
- Гейтвей/каналы/cron НЕ поднимаются до ступени 1 (`plans/10`). Только `openclaw agent --local ...`.
- В воркспейсе `~/.openclaw/workspace/TOOLS.md` — правило дисциплины тул-коллов (обход llama.cpp
  #20260): вызывая инструмент, модель не пишет текст в том же сообщении.
- Песочница для бенчей — отдельный профиль `--profile pilot` (`~/.openclaw-pilot`), гоняется
  `tools/openclaw-chain-bench.mjs`.
