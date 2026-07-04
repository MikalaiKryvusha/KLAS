# Баг 03 — ссылки пульта: локальный вход и Open WebUI

**Статус:** 🟡 фикс применён и проверен локально (2026-07-04) — ждёт подтверждения владельца с
телефона (удалённый вход через funnel). Пункт «Kiwix в Open WebUI» вынесен как отдельная задача.

Симптомы (со слов владельца):

**Локально:**
1. `http://localhost/` — не открывается, на весь экран: **«Host validation failed. See logs for more
   details.»**
2. KLAS Chat зашит на funnel-адрес `https://krinikspc.forest-ratio.ts.net:8443/` — а локально хочется
   ходить локально, не через funnel.
3. Пульт моделей `http://localhost:3005/ui/` — **404**.
4. Kiwix `http://localhost:3005/wiki/` — **404**.

5. `http://localhost/ui/#/logs` — красный статус, логи пустые, «ничего не видит».

**Через Tailscale Funnel с телефона** — наконец заработало, НО: LLM внутри Open WebUI утверждает, что
не видит базу Kiwix (`list_knowledge_bases` / `search_knowledge_files` возвращают пусто).

---

## Диагноз (истинные причины)

Баги 1, 3, 4 — **один корень**. Причина 2 — отдельная. «Kiwix в Open WebUI» — вообще не баг ссылок.

### Причина A (баги 1, 3, 4): host-валидация homepage + заход мимо Caddy

- Пульт (gethomepage 1.11.0) — корневое Next.js-приложение. Динамические данные (пинги сервисов,
  виджеты) тянутся через **Next.js Server Actions** (POST). Их хост валидируется в `middleware.js`:
  берётся Host запроса `b` и проверяется **точным** совпадением `HOMEPAGE_ALLOWED_HOSTS.split(",")
  .includes(b)` (поддерживается также спецзначение `*` = всё).
- Начальный GET страницы всегда отдаёт 200 (даже для чужого хоста) — падают именно POST-ы Server
  Actions → на экране большой красный **«Host validation failed»**. В логах homepage:
  `Host validation failed for: localhost. Hint: Set the HOMEPAGE_ALLOWED_HOSTS…`.
- Порт по умолчанию (80/443) в заголовке `Host` **отсутствует**, поэтому при заходе через Caddy `:80`
  на `http://localhost/` хост = голый `localhost`. А в списке было только `localhost:3005` — точного
  совпадения нет → валидация падает. **Это и есть баг 1.**
- Из-за неработающего `http://localhost/` владелец заходил напрямую на homepage `http://localhost:3005/`.
  Но ссылки-виджеты `/ui/` и `/wiki/` — **относительные** и маршрутизируются только Caddy; сам homepage
  таких путей не знает → `localhost:3005/ui/` и `localhost:3005/wiki/` дают 404/редирект. **Это баги 3 и 4.**
  То есть 3 и 4 — не самостоятельные дефекты, а следствие бага 1 (заход не через тот вход).
- `disableHostValidation: true` / `allowIframe` / `host` в `homepage/config/settings.yaml` — **не
  существующие у homepage настройки** (no-op); они создавали ложное ощущение, что валидация решена.
  Единственный реальный рычаг — переменная `HOMEPAGE_ALLOWED_HOSTS`.

### Причина C (баг 5): llama-swap UI дёргает свой API на КОРНЕ, а Caddy отдаёт корень homepage

- UI llama-swap живёт под `/ui/` (статика), но живые данные тянет с **корня**: `EventSource
  /api/events` (статус), `/logs` (логи), плюс `/running`, `/upstream/*`, `/unload`,
  `/api/performance|version|models`. У llama-swap НЕТ опции базового префикса (`--help`: только
  `-listen`/`-config`), эти пути жёстко зашиты.
- Caddy `(klas_web)` проксировал на llama-swap только `/ui*`; все корневые API-пути падали в catch-all
  `handle {}` → **homepage** → 404. Поэтому `/ui/` открывался (200), но SSE `/api/events` = 404 →
  красный статус, а `/logs` = 404 → пустые логи. **Это баг 5.**
- Подпути llama-swap (`/api/events|performance|version|models`, `/logs`, `/running`, `/upstream`,
  `/unload`) **не пересекаются** с `/api/*` самого homepage (`/api/config|services|widgets|…`) —
  проверено: на homepage они дают 404, а его собственные — работают. Значит их можно точечно
  направить на llama-swap, не задев пульт.

### Причина B (баг 2): статичная ссылка не может быть и локальной, и удалённой

- Open WebUI — root-приложение, не живёт под подпутём (поэтому отдаётся отдельным портом funnel `:8443`,
  а не через Caddy-подпуть). Один статичный `href` не может одновременно быть локальным
  (`http://localhost:3080/`) и удалённым (`https://…:8443/`). Было зашито удалённое → локально гоняло
  через funnel, чего владелец не хочет.

### Не баг (пункт про Kiwix в Open WebUI)

- Kiwix — самостоятельный сервер оффлайн-википедии (`.zim`). «Базы знаний» Open WebUI — его собственный
  внутренний RAG-стор загруженных документов. Это **разные сущности**. `list_knowledge_bases` честно
  возвращает пусто: в RAG Open WebUI ничего не загружали, и Kiwix туда автоматически не попадает.
  Чтобы LLM в Open WebUI искал по Kiwix, нужна **отдельная фича** — инструмент/функция Open WebUI,
  дергающая поисковый API Kiwix. Требует решения владельца → вынести в `ideas/` (не входит в этот баг).

---

## Фикс (2026-07-04)

1. **`docker-compose.yml`** (versioned) — в `HOMEPAGE_ALLOWED_HOSTS` добавлены голые `localhost` и
   `127.0.0.1` (для входа через Caddy `:80`): →
   `localhost,127.0.0.1,localhost:3005,127.0.0.1:3005,krinikspc.forest-ratio.ts.net`. Причина
   расписана комментарием прямо в файле.
2. **`caddy/Caddyfile`** (вне git — секреты) — ссылка на чат сделана относительной `/chat`, а каждый
   вход редиректит её на свой адрес:
   - `:80` (локально): `redir /chat http://localhost:3080/ 302`;
   - `:443` (funnel, до basicauth): `redir /chat https://krinikspc.forest-ratio.ts.net:8443/ 302`.

   Так локально ходим локально, с телефона — через funnel, ссылка на пульте одна.
5. **`caddy/Caddyfile`** — в общий сниппет `(klas_web)` добавлен именованный матчер `@swap_api` и
   `handle`, проксирующий корневые API-пути llama-swap на `host.docker.internal:8080`
   (`/api/events`, `/api/performance`, `/api/version`, `/api/models*`, `/logs*`, `/upstream/*`,
   `/unload`, `/running`) — до catch-all homepage. Чинит баг 5 сразу и локально, и через funnel.
3. **`homepage/config/services.yaml`** (в .gitignore) — `href` чата: `/chat` вместо funnel-URL.
4. **`homepage/config/settings.yaml`** (в .gitignore) — удалены фейковые `disableHostValidation`/
   `allowIframe`/`host`; оставлен комментарий-указатель на `HOMEPAGE_ALLOWED_HOSTS`.

Применение: `docker compose up -d homepage` (подхватить env) + `caddy reload`.

## Проверка (curl, 2026-07-04)

- Через Caddy `:80`: `/`=200, `/wiki/`=200, `/ui/`=200; `/chat`→302→`http://localhost:3080/`.
- server-action POST с `Host: localhost` → **200** (раньше падал); свежих `Host validation failed` в
  логах homepage — **0**.
- Через `:443` (plain HTTP, как отдаёт tailscaled): `/chat`→302→`https://…:8443/`; `/`→401,
  `/llm/v1/models` без ключа→401 (basicauth и защита LLM-API целы).
- llama-swap UI (баг 5): через Caddy `:80` `/api/events`→200 `text/event-stream` (SSE ожил),
  `/logs`/`/running`/`/api/performance`/`/api/version`/`/unload`→200; homepage не задет
  (`/`, `/ui/`, `/wiki/`, `/api/services`, `/api/widgets`→200); через funnel `/api/events`→401
  (под basicauth — после логина статус в UI зелёный и удалённо).

## Осталось

- ✅ Владельцу: открыть `http://localhost/` (не `:3005`!) — пульт должен грузиться без красного экрана,
  все виджеты живые; клик по «KLAS Chat» локально ведёт на `localhost:3080`, с телефона — на `:8443`.
- ✅ Интеграция Kiwix в Open WebUI оформлена отдельно — **идея 11** (`ideas/11_kiwix_in_openwebui.md`):
  тул `open-webui/tools/kiwix_search.py` (поиск по всем книгам/языкам, авто-подхват новых `.zim`),
  проверен; владельцу — разово вставить в Open WebUI → Tools.
