# Bug 04 — Open WebUI не «под ключ» + веб llama-swap (панель, Playground 404)

**Статус:** 🔧 фикс применён и проверен браузером — ждёт подтверждения владельца
**Когда/контекст:** 2026-07-04, владелец пытался дать брату доступ к семейному чату; параллельно —
жалобы на веб llama-swap (`http://localhost/ui/`).

---

## Симптомы (со слов владельца)

1. **Open WebUI недонастроен «из коробки».** Брат не смог зарегистрироваться (регистрация была
   выключена). Владелец включил вручную — брат создал аккаунт, попал в группу `family`, но **у группы
   нет прав** и **в новом чате не видно ни одной модели**. Нужна «гостевая система под ключ»: KLAS
   разворачивает Open WebUI СРАЗУ готовым — регистрация включена, у родных права почти как у админа
   (все чаты, все модели видны, все инструменты).
2. **llama-swap UI без боковой панели.** Боковой ящик «мелькает на секунду и исчезает при обновлении»
   — нельзя переключаться на вкладки (Activity, Playground, …).
3. **Playground llama-swap: `404 This page could not be found`** при попытке пообщаться; после 404
   «ящик ломается опять» (пропадает вся навигация).

## Воспроизведение (детерминированное, браузерный харнесс)

Собран харнесс `tools/web-shot.mjs` (playwright): открывает URL настоящим Chromium, снимает скриншот,
собирает ошибки консоли и упавшие/4xx-запросы. Именно он дал «глаза» для этого бага.

```
node tools/web-shot.mjs "http://localhost/ui/" out.png --width=1600           # снимок + диагностика
node tools/web-shot.mjs "<url>" out.png --cookie=sidebar_state=false           # воспроизвести состояние
```

## Криминалистика / корневые причины

**(2) Боковая панель llama-swap = залипший cookie.** UI llama-swap v234 построен на компоненте shadcn
Sidebar. Кнопка «Toggle Sidebar» пишет cookie **`sidebar_state=false`**; при загрузке React стартует с
открытой панелью (вспышка), затем читает cookie и сворачивает её → «мелькнула и исчезла». Панель НЕ
пропадала: свёрнута в off-canvas, открывается иконкой-гамбургером слева вверху. Подтверждено: владелец
**почистил куки — панель появилась**; в харнессе клик Toggle Sidebar → выставляется `sidebar_state=false`.
Это встроенное поведение UI llama-swap, а не дефект KLAS. **Лечение: очистить cookie сайта либо кликнуть
иконку-гамбургер.**

**(3) Playground 404 = дыра в матчере Caddy.** Playground шлёт `POST http://localhost/v1/chat/completions`.
В `caddy/Caddyfile` матчер `@swap_api` перечислял корневые пути llama-swap вручную и **не включал `/v1/*`**
(и `/api/captures*`). Запрос проваливался в catch-all `handle { reverse_proxy homepage:3000 }` → homepage
отдавала свою Next.js-страницу `This page could not be found` полной навигацией, заменяя SPA llama-swap
(отсюда «ящик снова сломался»). Пойман харнессом: `REQ POST /v1/chat/completions → RESP 404`.

**(1) Open WebUI недонастроен = дефолты + PersistentConfig.** По исходнику `backend/open_webui/config.py`
(образ `:main`): `DEFAULT_USER_ROLE=pending` (новый юзер ждёт ручного одобрения админом) и ВСЕ
`USER_PERMISSIONS_WORKSPACE_*` = `False`, а модели по умолчанию под access-control (не видны без групп).
Плюс эти настройки — **PersistentConfig**: env читается лишь при ПЕРВОМ старте, дальше значение живёт в
БД и env игнорируется — поэтому правки `docker-compose.yml` на уже инициализированной БД владельца не
действовали.

## Фикс (сделан)

**(2) Панель** — поведение стороннего UI, кода KLAS не касается. Задокументировано лечение (очистить
куки / гамбургер) здесь и в `AGENT_GUIDE.md`. Дефект не наш.

**(3) Playground 404** — `caddy/Caddyfile`, матчер `@swap_api` расширен: добавлены `/v1/*`
(весь Playground: chat/images/speech/transcription/rerank/load test) и `/api/captures*`. Коллизий с
homepage нет (у неё `/api/config|services|widgets|…`, `/v1/*` она не использует). `caddy reload` →
проверено харнессом: `POST /v1/chat/completions → 200`, модель qwythos-9b ответила в Playground.

**(1) Open WebUI «под ключ»** — `docker-compose.yml`, сервис `open-webui`, добавлено:
```
ENABLE_PERSISTENT_CONFIG=false      # env — источник правды на КАЖДОМ старте (конфиг как код; лечит «БД перекрывает env»)
ENABLE_SIGNUP=true                  # родные могут регистрироваться
ENABLE_LOGIN_FORM=true              # показывать форму логина/регистрации
DEFAULT_USER_ROLE=user              # новый юзер СРАЗУ активен (не 'pending' — без ручного одобрения)
BYPASS_MODEL_ACCESS_CONTROL=true    # ВСЕ видят/используют ВСЕ модели без создания групп и прав
USER_PERMISSIONS_WORKSPACE_MODELS_ACCESS=true
USER_PERMISSIONS_WORKSPACE_KNOWLEDGE_ACCESS=true
USER_PERMISSIONS_WORKSPACE_PROMPTS_ACCESS=true
USER_PERMISSIONS_WORKSPACE_TOOLS_ACCESS=true
```
Права на чаты/фичи (загрузка файлов, экспорт, code interpreter, web search, notes…) в Open WebUI по
умолчанию уже `True` для роли `user` — не дублируем (KISS). Данные БД (юзеры, чаты, модели, импортированный
kiwix-тул идеи 11) НЕ конфиг → при `ENABLE_PERSISTENT_CONFIG=false` не затрагиваются.

**Ключевая идея решения (KISS/Оккам):** не создавать группу `family` с ручной раздачей прав, а снять
барьеры глобально через `BYPASS_MODEL_ACCESS_CONTROL` + `DEFAULT_USER_ROLE=user`. «Гостевая система под
ключ» = не «правильно настроенная группа», а «барьеров нет вовсе» — для доверенного круга родных это
проще, надёжнее и воспроизводимо (конфиг в git, а не в мутабельной БД).

## Проверка (браузером, playwright)

- `/api/config` после пересоздания контейнера: `enable_signup:true`, `enable_login_form:true` — env
  перекрыл уже инициализированную БД (значит `ENABLE_PERSISTENT_CONFIG=false` работает).
- Зарегистрирован НОВЫЙ «близкий» (`test-family@klas.local`): попал **сразу в чат** (без экрана
  «ожидайте одобрения»), в селекторе видны **все 5 моделей** (gemma-4-12b, ornith-35b, qwen3.5-35b,
  qwen3.6-27b, qwythos-9b) + Arena. Ошибок консоли нет. Тестовый юзер после проверки удалён из БД
  (осталось 2: владелец + брат).
- llama-swap Playground после фикса Caddy: ответ модели получен (200), боковая панель на месте.

## Ссылки

- `tools/web-shot.mjs` — браузерный диагностический харнесс (первый кирпич «зрения» Jarvis, идея 05).
- `caddy/Caddyfile` (матчер `@swap_api`), `docker-compose.yml` (сервис `open-webui`).
- Связано: `ideas/09` (Open WebUI для родных), `ideas/11` (kiwix в чатах), баг 03 (маршруты Caddy),
  идея 05 (Jarvis: зрение рабочего стола).
