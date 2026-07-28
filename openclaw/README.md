# openclaw/ — конфигурация агентного ядра ассистента KLAS

**OpenClaw — принятое ядро ассистента** (решение владельца 2026-07-17, Q1 интервью 004; данные —
`researches/09_oss_constructor_map.md` §3.4). Выкат ступенями — `plans/10_openclaw_core_rollout.md`.

- `openclaw.json.example` — шаблон рабочего конфига. Живёт в git; рабочая копия — вне git, в
  `~/.openclaw/openclaw.json` (профиль по умолчанию). Развёртывание: `npm i -g openclaw`, скопировать
  шаблон в `~/.openclaw/openclaw.json`, проверить `openclaw config validate`.
- Ключевое в конфиге: провайдер `klas` → llama-swap `127.0.0.1:8080/v1`; у КАЖДОЙ модели обязателен
  `compat.unsupportedToolSchemaKeywords: ["pattern", "maxLength", "minLength", "maxItems", "minItems"]`
  (иначе llama.cpp 400 на схемах инструментов);
  > ⚠️ **Ключи-повторители (`maxLength` и соседи) добавлены 2026-07-28 — без них ядро не делает НИ
  > ОДНОГО хода** на движке новее ~b9754. Причина: встроенный тул `cron` объявляет
  > `trigger.script` с `maxLength: 65536`, генератор GBNF разворачивает это в `char{1,65536}`, а
  > парсер llama.cpp режет всё выше `MAX_REPETITION_THRESHOLD = 2000` → `400 Failed to initialize
  > samplers: failed to parse grammar` на любом запросе, даже «привет». Полный разбор —
  > `bugs/05_DONE_llamacpp_toolcall_grammar.md`. Тот же приём apply-ят модели xAI в самом OpenClaw.
  fallback №1 — `qwen3.5-35b-r` (алиас того же инстанса в `llama-swap/config.yaml` = ретрай той же
  модели при флейковой 500 peg-парсера тул-коллов, llama.cpp #20260); exec зажат
  (`tools.exec.mode: allowlist`, `ask: off`) — ступень 0 полномочий (Q4 интервью 004).
- Гейтвей: ступень 1 выполнена, поднимает/гасит `tools/klas.ps1` (`node openclaw.mjs gateway run`).
  > ⚡ **`gateway.http.endpoints.chatCompletions.enabled: true` добавлен 2026-07-28 — это ГЛАВНЫЙ
  > рычаг латентности голосового тракта.** Он открывает OpenAI-совместимый `POST /v1/chat/completions`
  > на самом гейтвее: тот же кодовый путь, что `openclaw agent`, но БЕЗ запуска процесса на каждый ход
  > (замер: 8.4–10.6 с накладных исчезают) и с SSE-стримингом ответа. Им ходит `tools/voice-talk.mjs`.
  > Безопасность: документация OpenClaw называет этот эндпоинт «полным операторским доступом» —
  > держать **только на loopback**, в funnel не публиковать. Разбор и замеры —
  > `researches/12_voice_latency_streaming.md`.
- В воркспейсе `~/.openclaw/workspace/TOOLS.md` — правило дисциплины тул-коллов (обход llama.cpp
  #20260): вызывая инструмент, модель не пишет текст в том же сообщении.
- Песочница для бенчей — отдельный профиль `--profile pilot` (`~/.openclaw-pilot`), гоняется
  `tools/openclaw-chain-bench.mjs`.
