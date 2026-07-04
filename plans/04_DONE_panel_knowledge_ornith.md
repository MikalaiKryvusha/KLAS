# План 04 — Фаза приятных мелочей (идея 08): Ornith, пульт, база знаний для LLM

> Реализует `ideas/08_panel_knowledge_and_ornith.md`. Статус: ✅ DONE (2026-07-03) — Ornith замерена, пульт homepage, база знаний openzim-mcp; релиз 0.2.
> По итогу — коммит, push, релиз 0.2 (First KLAS), минимальные правки README/release из 0.1.

## Задача 1 — Ornith-1.0-35B: скачать, настроить, замерить

- ✅ Итог: Ornith-1.0-35B оказалась **MoE A3B** (не плотная), квант IQ3_XXS 13.84 GiB. agent-bench
  6/6, генерация 117 t/s, SWE-bench 75.6 — умная. НО prompt-processing аномально медленный
  (needle-16K ~214 с) → для чата/коротких задач, не для длинных агентных промптов. Добавлена в
  llama-swap (ctx 49K), занесена в `researches/02`.

## Задача 2 — Пульт Фазы 5: единый вход через homepage (быстро)

- Перестроить `homepage/config/services.yaml` в **пульт KLAS**: убрать мёртвый AnythingLLM;
  добавить группы: **LLM** (веб-UI llama-swap `/ui/` — модели/загрузка/выгрузка/метрики),
  **Знания** (kiwix `/wiki`), **Доступ** (удалённый API, статус сервисов).
- Статусы up/down — виджеты `siteMonitor` на health-эндпоинты (через `host.docker.internal`).
- Заголовок пульта в `settings.yaml`. Проверка: homepage на :3005 / через caddy `/homepage`.

## Задача 3 — База знаний для LLM

**3a. `tools/deploy-knowledge.mjs`** — опциональный скрипт скачивания `.zim` с download.kiwix.org в
`kiwixdb/` (для свежих установок и добавления баз). У владельца уже ~73 ГБ .zim (ru-wikipedia 41 ГБ,
wikibooks/wikisource/wikiversity EN+RU). Скрипт: список рекомендованных .zim + докачка по выбору.

**3b. MCP-адаптер поиска по википедии** — заимствуем готовое: **openzim-mcp**
(`cameronrye/openzim-mcp`, читает `.zim` напрямую, оффлайн; инструменты `zim_query`/`zim_search`/…).
- Установить (`pip install openzim-mcp`), проверить на нашем `kiwixdb/`.
- Дать конфиг MCP для Zoo Code (агент получает инструмент «искать в локальной википедии») +
  `tools/setup-knowledge-mcp.mjs` (ставит сервер и пишет конфиг). Это и есть слой, «объясняющий»
  агенту, как искать в неограниченной локальной базе знаний.
- Документировать в `homeworks/` (владелец включает MCP в своём Zoo Code).

## Итог — релиз 0.2

Коммит + push. README и release-notes из 0.1 берём целиком, минимально правим под: Ornith в пуле,
пульт homepage, база знаний для LLM (openzim-mcp). Версия → 0.2, имя «First KLAS».
