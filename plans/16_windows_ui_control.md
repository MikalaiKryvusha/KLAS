# План 16 — Ядро управления Windows UI (голосом → агент → мышь/клавиатура/клик по UIA)

> Приоритет владельца (2026-07-18): *«голосом управление Windows UI — попросить агента открыть
> приложение, поставить туда курсор, набрать с клавиатуры, нажать ту кнопку — делаем ядро этого
> функционала»*. Реализует часть [idea 05 (Jarvis)](../ideas/05_Jarvis.md) и ступень 2 эпика
> ([plans/10](10_openclaw_core_rollout.md), [plans/08](08_assistant_epic_roadmap.md)); решение принято
> в [интервью 004 Q4 = A](../interviews/interview_004_oss_constructor.md) — *ступенчато, allow-list*.
> Канон OSS — [researches/09 §3.5](../researches/09_oss_constructor_map.md).
>
> **Статус (2026-07-28): 🔧 Фазы 1–3 ВЫПОЛНЕНЫ и ПРОВЕРЕНЫ. Фаза 4 ПРОГНАНА ЖИВЬЁМ (4 прогона по «go»
> владельца) — ядро UI работает частично, упирается в дефект движка, не в Windows-MCP.** Тег `DONE` не
> ставить.
>
> **Что доказано живым прогоном 2026-07-28:**
> - ✅ **Работают:** `App launch_executable` (Блокнот реально открылся — подтверждено владельцем),
>   `Wait`, `WaitFor`, `Snapshot` (UIA-дерево читается, элементы по-русски), адресация по UIA —
>   модель верно определила label области редактирования (**475**).
> - ❌ **Не доходит до действия:** ход умирает на ПЕРВОМ действующем тул-колле (`Type`/`Click`) —
>   модель отдаёт XML-формат `<tool_call><function=windows__Type><parameter=…>`, а peg-парсер
>   llama.cpp b9538 его не принимает. **2/2 воспроизводимо, на всех трёх моделях цепочки** — это не
>   9%-флейк из EXP-0003, а систематика на MCP-инструментах.
> - 🔎 **Корень найден:** апстрим [llama.cpp#24807](https://github.com/ggml-org/llama.cpp/issues/24807)
>   (ровно наша модель и симптом) закрыт 21.06.2026, рабочий билд — **после b9754**; наш движок был
>   собран 06.06.2026 (**b9538**), то есть старше фикса. Обновление на свежий **b10167 не подошло** —
>   он ломает грамматику тул-коллов вообще (`bugs/05`), откачены обратно на b9538.
> - ⛔ **Блокер фазы 4:** нужен билд llama.cpp между b9760 и b10167 (бисекция — в `bugs/05`). До этого
>   живой тест дальше `Snapshot` не пройдёт.
>
> **Две поправки к канону этого плана (оплачены прогоном):**
> 1. **В команде фазы 4 НЕЛЬЗЯ передавать `--model`** — явный флаг выключает цепочку fallback целиком
>    (`modelOverrideSource: "user"` → пустой список, исходники OpenClaw 2026.7.1). Именно поэтому
>    ретрай-алиас `qwen3.6-35b-a3b-r` не срабатывал ни разу. Без флага цепочка отрабатывает честно:
>    `qwen3.6 → qwen3.6-r → qwen3.5`. Подробности — `EXPERIENCE.md` EXP-0005.
> 2. **Одобрений на действие при `agent --local` НЕТ** — `plugin_approval_requested` живёт в Control UI
>    гейтвея, а `--local` его не поднимает. На локальных прогонах защита = allow-list 7 тулов + присмотр.
> 3. **Понизить права из административной сессии не удалось** (ни `explorer.exe`, ни COM `ShellExecute`) —
>    все 4 прогона шли с админскими правами, вопреки пункту 4 «честных оговорок». Лечится средой: не
>    держать VS Code запущенным от администратора. Подробности — EXP-0007.
>
> **Что реально сделано и проверено:**
> - **uv** поставлен как standalone-бинарь `F:\KLAS\mcp\uv\uv.exe` (v0.11.29, скачан из GitHub-релиза; pip
>   на системном Python 3.14 отсутствует, удалённый `irm|iex` НЕ использован — безопаснее).
> - **Windows-MCP v0.8.2** склонирован в `F:\KLAS\mcp\Windows-MCP-v0.8.2`, венв на **Python 3.13.14**
>   (uv managed, не системный 3.14), `uv sync` собрал зависимости (`windows-mcp==0.8.2`). Смоук
>   `serve --help` ок.
> - Подключён в OpenClaw как stdio-MCP `mcp.servers.windows` (правкой конфига — обход quote-mangling
>   PowerShell). `openclaw mcp doctor windows --probe` = **ok**.
> - **Проверено probe: ровно 7 чистых тулов** — `App, Snapshot, Screenshot, Click, Type, Wait, WaitFor`.
>   Опасных (PowerShell/FileSystem/Registry/Process/Scrape/Clipboard/Notification/Multi*/Move/Scroll/
>   Shortcut) — НЕТ. Allow-list в два слоя (`--tools` сервера + `toolFilter.include` OpenClaw).
> - **Поправка к ресёрчу:** тула `DisplayInventory` в v0.8.2 **НЕ существует** (ресёрч-агент выдумал имя) —
>   ядро = 7 реальных тулов, а не 8. Канонический список имён — `@mcp.tool(name=...)` в
>   `Windows-MCP-v0.8.2/src/windows_mcp/tools/`.
> - **Pre-flight видимости для агента:** `sandbox.mode=off`, `tools.deny` пуст, MCP-тулы (`bundle-mcp`)
>   отдаются по умолчанию → на Фазе 4 агент увидит `windows__*`. Если вдруг нет — выставить
>   `agents.defaults.tools.profile=coding`.
> - **Фаза 4 (живой тест) НЕ запускалась** — по слову владельца «пока без тестов, не трогай мой комп».
>   Запускать под присмотром, комп свободен, через `openclaw agent --local` (читает конфиг свежим,
>   рестарт гейтвея не нужен), с одобрением на действие.

---

## Что строим (ядро)

Дать агентному ядру OpenClaw (модель `qwen3.6-35b-a3b`) инструменты управления Windows 11:
**открыть приложение · подвинуть курсор · набрать текст · кликнуть КОНКРЕТНУЮ кнопку** — с наведением
на элемент по дереву доступности **UIA** (а не по слепым пикселям). В будущем это же ядро дёргается
голосом через Android-ноду/хостовый тракт.

## Выбор компонента (по правилу живости OSS)

**Сервер: [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP)** — MIT, **6457★,
последний push 2026-07-18 (сегодня)**, релиз v0.8.2. Живость подтверждена (`gh api`: archived=false,
свежий push, звёзды). Это единственный из кандидатов, который является именно **MCP-сервером
инструментов** (а не автономным агентом), точно ложится в наш стек (OpenClaw подключает stdio-MCP
штатно), и имеет **потуловый вкл/выкл**. Отвергнуты: `CursorTouch/Windows-Use` (это LangChain-**агент**
со своим мозгом — неверная форма), `microsoft/UFO` (тяжёлый мульти-агентный комбайн — оверкилл).

Один MCP-эндпоинт даёт 20 инструментов (мышь/клавиатура/запуск/UIA-дерево/скрин/**и опасные**
shell/FS/registry/process). Мы включаем **только 8** (см. Безопасность).

## ⚠️ Честные оговорки (важно для «не трогай мой комп»)

1. **Windows-MCP физически двигает реальные мышь и клавиатуру.** Даже когда цель задана по UIA-`label`,
   `Click`/`Type` резолвят элемент в его центр и бьют **синтетическим кликом** (`SetCursorPos` +
   `mouse_event`), `Type` = клик + `SendKeys`/вставка из буфера. Фонового `UIA InvokePattern` (без
   перехвата курсора) у него НЕТ. Для владельца это **совпадает** с желанием «поставить курсор» — курсор
   реально двигается. Но значит: во время работы агент **занимает** твои мышь/клавиатуру, поэтому первые
   прогоны — под присмотром и по одобрению (Этап 1), а автономка — лучше в отдельной сессии/VM.
2. **Это твой боевой ПК, не песочница.** SECURITY.md вендора требует выделенную машину / VM / Windows
   Sandbox со снапшотами. Allow-list из 8 инструментов убирает необратимое (shell/FS/registry/process),
   но `Click`/`Type` всё равно могут ткнуть в **любое видимое** окно. Митигируем: одобрение на действие +
   присмотр; для автономки — VM/Sandbox.
3. **Нет встроенного allow-list приложений.** `App` запускает любое имя из меню Пуск / любой .exe. Гейт —
   через одобрение, либо (строгий этап) отключить `App` и запускать разрешённые программы вручную, либо
   собственный MCP (см. Альтернатива).
4. **Не-elevated:** сервер запускаем от обычного пользователя (least privilege). Тогда он НЕ сможет
   управлять окнами админ-приложений (UIPI) — это фича безопасности, не баг. Никогда не запускать сервер
   от админа.
5. Локаль ru-RU при UI-языке en-US: запуск приложений — по **пути .exe** (`launch_executable`), не по
   фаззи-имени меню Пуск. `Type` длиннее 20 симв. временно перезаписывает буфер обмена. Нужна
   **интерактивная сессия на переднем плане** (не headless/Session-0/отключённый RDP).

## Безопасность (ступень 1, интервью 004 Q4 = A) — allow-list в ДВА слоя

**ВКЛЮЧАЕМ ровно 7 (запрошенное ядро; реальные имена v0.8.2):** `App`, `Snapshot`, `Screenshot`, `Click`,
`Type`, `Wait`, `WaitFor`. (`Snapshot` — UIA-чтение, отдаёт `label` элементов; `Click`/`Type` бьют по
`label`; `Click clicks=0` = навести курсор без клика.) *(Ресёрч называл 8-й тул `DisplayInventory` —
его в v0.8.2 нет.)*

**ВЫКЛЮЧАЕМ ВСЕГДА (полный доступ к системе):** `PowerShell`, `FileSystem`, `Registry`, `Process`,
`Scrape`, `Notification`, `Clipboard`, `MultiSelect`, `MultiEdit`.
**ДЕРЖИМ ВЫКЛ до конкретной надобности:** `Move` (drag разрушителен), `Scroll`, `Shortcut` (глобальные
хоткеи Win+R/Alt+F4).

Enforcement (defense-in-depth, allow-list — всё новое от апстрима по умолчанию запрещено):
1. **На стороне сервера:** флаг `--tools "App,Snapshot,Screenshot,DisplayInventory,WaitFor,Wait,Click,Type"`
   (allow-list, перекрывает любые exclude).
2. **На стороне OpenClaw:** `toolFilter.include` тем же списком (`openclaw mcp tools windows --include ...`).
3. **Жёсткий рубильник:** при нужде `tools.deny: ["windows__*"]` гасит весь сервер разом.
4. **Одобрение на действие (Этап 1):** OpenClaw шлёт `plugin_approval_requested` → allow-once/allow-always/
   deny в Control UI `/settings/mcp`. Первые прогоны — только так, под присмотром. Авто — после доверия.

⚠️ MCP-инструменты **не** покрываются `tools.exec allowlist` (это только для host-exec/shell). Гейт MCP —
это toolFilter + tools.deny + одобрения. Профиль инструментов агента должен быть `coding`/`messaging`
(в `minimal` MCP скрыты); при `sandbox.mode=all/non-main` добавить `bundle-mcp` в
`tools.sandbox.tools.alsoAllow`.

---

## Пошагово — команды готовы, НЕ запускались (ждут «go» владельца)

### Фаза 1 — установка Windows-MCP в `F:\KLAS\mcp\` (не трогает UI)
```powershell
# 1.1 uv отсутствует. БЕЗ удалённого скрипта:
python -m pip install uv            # (альт: irm https://astral.sh/uv/install.ps1 | iex — но это pipe|iex)
uv --version                        # в НОВОМ окне (обновится PATH)
# 1.2 клон на релиз-тег, в версионированную папку (как web-search-mcp-v0.3.2)
git clone --depth 1 --branch v0.8.2 https://github.com/CursorTouch/Windows-MCP "F:\KLAS\mcp\Windows-MCP-v0.8.2"
# 1.3 венв на Python 3.13 (НЕ системный 3.14 — риск нативных колёс comtypes/dxcam/pywin32)
cd "F:\KLAS\mcp\Windows-MCP-v0.8.2"; uv python pin 3.13; uv sync
# 1.4 смоук: сервер резолвится и импортируется (печатает опции, выходит)
uv run windows-mcp serve --help
```

### Фаза 2 — подключение к OpenClaw (только запись конфига, без действий на UI)
```powershell
openclaw mcp add windows --command uv --arg run --arg --directory --arg F:/KLAS/mcp/Windows-MCP-v0.8.2 `
  --arg windows-mcp --arg serve --arg --tools --arg "App,Snapshot,Screenshot,DisplayInventory,WaitFor,Wait,Click,Type" `
  --env UV_NO_SYNC=1 --env ANONYMIZED_TELEMETRY=false --cwd F:/KLAS/mcp/Windows-MCP-v0.8.2 `
  --include "App,Snapshot,Screenshot,DisplayInventory,WaitFor,Wait,Click,Type"
# если парсер спотыкается на "--arg --directory" (значение с --), эквивалент через JSON (mcp set НЕ пробит — пробить вручную в Фазе 3):
# openclaw mcp set windows '{"command":"uv","args":["run","--directory","F:/KLAS/mcp/Windows-MCP-v0.8.2","windows-mcp","serve","--tools","App,Snapshot,Screenshot,DisplayInventory,WaitFor,Wait,Click,Type"],"cwd":"F:/KLAS/mcp/Windows-MCP-v0.8.2","env":{"UV_NO_SYNC":"1","ANONYMIZED_TELEMETRY":"false"},"toolFilter":{"include":["App","Snapshot","Screenshot","DisplayInventory","WaitFor","Wait","Click","Type"]}}'
```

### Фаза 3 — верификация проводки (probe только перечисляет тулы, UI не трогает)
```powershell
openclaw mcp doctor windows --probe     # статик-проверки + live-коннект
openclaw mcp probe windows --json       # должно перечислить РОВНО 8: windows__App/Snapshot/Screenshot/DisplayInventory/WaitFor/Wait/Click/Type
openclaw doctor                          # ловит sandbox/tool-policy рассинхрон
openclaw sandbox explain                 # эффективные allow/deny для агента
openclaw mcp reload                      # сбросить кэш MCP в текущем процессе (гейтвею — свой рестарт)
```

### Фаза 4 — 🔴 ЖИВОЙ ТЕСТ (ТОЛЬКО по «go» владельца, комп свободен, под присмотром)
```powershell
# ⚠️ БЕЗ --model: явный флаг выключает цепочку fallback (EXP-0005). Модель берётся primary из конфига.
# ⚠️ Окно Блокнота на русской Windows называется «Блокнот» — фаззи-switch по имени "Notepad"
#    уводит в Notepad++ (проверено 2026-07-28). Запуск — строго по пути .exe.
# ⚠️ Числа в скобках вида (659,2100) — ЭКРАННЫЕ КООРДИНАТЫ, а не label; модель их путает, это надо
#    сказать в промпте явно (без этой строки прогон падает на «Label 659 out of range»).
openclaw agent --local --session-key uia-test -m "Use ONLY the windows MCP tools. This Windows is Russian: the Notepad window is titled Блокнот. Rule A: numbers in parentheses like (659,2100) are SCREEN COORDINATES, never labels. A label is the small integer index printed for an interactive element. Rule B: never switch to any application whose name contains ++ or Code or Visual. Step 1. App with mode launch_executable and executable C:\Windows\System32\notepad.exe . Step 2. WaitFor with mode active_window and window_name Блокнот and timeout 15. Step 3. Snapshot with use_ui_tree true. Step 4. Type with the integer label of the editing area and text KLAS UIA test. Step 5. Snapshot again and report the labels used."
```
> Прогон 2026-07-28 доходит до шага 4 и падает на дефекте грамматики движка (`bugs/05`). Повторять
> ПОСЛЕ смены билда llama.cpp — тогда же снимать статус фазы.

## Альтернатива (если захотим «тихий» режим без перехвата курсора)
Свой мини-MCP (~150–250 строк, Python + `uiautomation`/pywinauto + `fastmcp`, stdio — проводка в OpenClaw
идентична): `ui_snapshot` (read-only обход UIA), `ui_invoke(id)` = **настоящий фоновый** `InvokePattern.
Invoke()`/`Toggle`/`Select` (БЕЗ движения курсора и синтетической мыши), `ui_set_value(id,text)` =
`ValuePattern.SetValue()`, `app_launch(name)` — **только из хардкод-allow-list имя→exe** (тот самый гейт,
которого нет у Windows-MCP), `ui_focus(window)`. Никаких shell/FS/registry/hotkey/координатных кликов —
опасной поверхности просто нет. Минус: `InvokePattern` есть не у всех приложений (canvas/игры/плохой UIA
→ придётся падать в координаты, т.е. снова курсор), и это **противоречит** желанию «поставить курсор».
Вывод: берём Windows-MCP как ядро (совпадает с видением «курсор+клавиатура+клик»), собственный MCP —
опция, если позже понадобится именно фоновое управление.

## Риски (сводка)
- Нативные колёса под Python 3.14 → пинить 3.13 (Фаза 1.3).
- Реальный ПК не в песочнице → одобрение + присмотр; автономка → VM/Sandbox.
- Нет app-allow-list у `App` → одобрение / предзапуск / свой MCP.
- Модель — слабое звено (qwen 6.7/8 v3): держать одобрение, `WaitFor` вместо слепого `Wait`.
- `Type` затирает буфер обмена (≥20 симв.); может ронять символы на нагруженной машине.
- Нужна интерактивная сессия переднего плана; не-elevated (админ-окна недоступны — это ок).

## Зависимости и что дальше
- Голосовой вход в это ядро — по [plans/07](07_jarvis_gateway_and_client.md) (Pipecat) и вкладке Voice
  ноды ([plans/14](14_voice_g4_android_node.md)); Windows-MCP — «руки», ядро OpenClaw — «мозг».
- После «go»: Фаза 1→3 (установка+проводка+probe, UI не трогаем) → Фаза 4 под присмотром → снять статус,
  зафиксировать allow-list как канон, при желании — свой app-allow-list-MCP.
