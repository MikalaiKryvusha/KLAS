# KLAS — карта ссылок

Единая карта доступа к сервисам KLAS: что где открывается локально и через интернет. Реальные
значения владельца — в `LINKS.local.md` (вне git); секреты — в `caddy/PASSWORD.local.txt`.

Обозначения: `<ХОСТ>` — ваш публичный Tailscale-хост (вида `<ваша-машина>.ts.net`); `<ЛОГИН>` —
логин basicauth (задаётся при генерации хеша в `caddy/Caddyfile`).

## 🖥 Локально (с этого ПК)

| Что | Ссылка | Доступ |
|-----|--------|--------|
| **Пульт KLAS** (главный вход) | http://localhost/ | без пароля (Caddy :80, только эта машина) |
| Пульт напрямую (homepage) | http://localhost:3005/ | без пароля |
| Пульт моделей (llama-swap UI) | http://localhost:8080/ui/ | без пароля |
| Чат (Open WebUI) | http://localhost:3080/ | свой логин Open WebUI |
| Википедия (Kiwix) | http://localhost:8081/wiki/ | без пароля |

## 🌐 Удалённо (интернет, Tailscale Funnel)

| Что | Ссылка | Доступ |
|-----|--------|--------|
| **Пульт KLAS** | https://&lt;ХОСТ&gt;/ | basicauth (`<ЛОГИН>` + пароль) |
| Википедия (Kiwix) | https://&lt;ХОСТ&gt;/wiki/ | basicauth |
| Пульт моделей (llama-swap UI) | https://&lt;ХОСТ&gt;/ui/ | basicauth |
| **LLM-API** (OpenAI-совм.) | https://&lt;ХОСТ&gt;/llm/v1 | Bearer-ключ (в `caddy/PASSWORD.local.txt`) |
| **Чат** (Open WebUI) | https://&lt;ХОСТ&gt;:8443/ | свой логин Open WebUI |

## 🎛 Управление

- Ярлык **KLAS** (Рабочий стол / корень проекта) или иконка в трее: **Open KLAS control panel** /
  **Stop KLAS and exit**. Ярлык ставит `tools/install-klas-shortcut.ps1`.
- Вручную: `powershell -File tools\klas.ps1 -Action up` (поднять всё) / `-Action down` (погасить всё).
- Автозапуск при входе в систему: `powershell -File tools\install-autostart.ps1` (один раз).

## 🧭 Как устроен доступ

- **Единый вход через Caddy.** Локально — `:80` (без пароля, слушает только 127.0.0.1). Публично —
  `:443` через Tailscale Funnel под basicauth. Ссылки-виджеты пульта относительные (`/wiki/`, `/ui/`) —
  поэтому одинаково работают локально и удалённо.
- **Open WebUI** — root-приложение (не живёт под подпутём), поэтому отдаётся отдельным портом
  Funnel `:8443` напрямую, со своей авторизацией.
- **Лимит Tailscale Funnel — порты 443 / 8443 / 10000.** Это не ограничивает число сервисов: на 443
  Caddy разводит сколько угодно приложений по путям (`/wiki`, `/ui`, `/llm`, …).
