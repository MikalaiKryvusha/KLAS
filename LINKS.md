# KLAS — карта ссылок

Что где открывается. Реальные значения владельца — в `LINKS.local.md` (вне git), секреты — в
`caddy/PASSWORD.local.txt`. `<ХОСТ>` — публичный Tailscale-хост (`<машина>.ts.net`), `<ЛОГИН>` —
логин basicauth.

## 🖥 Локально (с этого ПК) — вход `http://localhost/`

| Что | Ссылка | Доступ |
|-----|--------|--------|
| **Пульт KLAS** (главный вход) | http://localhost/ | без пароля (Caddy :80) |
| Пульт моделей (llama-swap UI) | http://localhost/ui/ | без пароля |
| Википедия (Kiwix) | http://localhost/wiki/ | без пароля |
| Чат (Open WebUI) | http://localhost:3080/ | свой логин Open WebUI |

## 🌐 Удалённо (интернет, Tailscale Funnel) — вход `https://<ХОСТ>/`

| Что | Ссылка | Доступ |
|-----|--------|--------|
| **Пульт KLAS** | https://&lt;ХОСТ&gt;/ | basicauth (`<ЛОГИН>`) |
| Пульт моделей (llama-swap UI) | https://&lt;ХОСТ&gt;/ui/ | basicauth |
| Википедия (Kiwix) | https://&lt;ХОСТ&gt;/wiki/ | basicauth |
| **LLM-API** (OpenAI-совм.) | https://&lt;ХОСТ&gt;/llm/v1 | Bearer-ключ |
| **Чат** (Open WebUI) | https://&lt;ХОСТ&gt;:8443/ | свой логин Open WebUI |

> Ссылку на чат на пульте (`/chat`) Caddy редиректит сам: локально → `:3080`, через funnel → `:8443`.

## 🎛 Управление

- Ярлык **KLAS** (Рабочий стол / трей): **Open KLAS control panel** / **Stop KLAS and exit**.
- Вручную: `tools\klas.ps1 -Action up` / `-Action down`. Автозапуск: `tools\install-autostart.ps1`.

## 🧭 Как устроен доступ

- **Единый вход — Caddy.** Локально `:80` (без пароля, только 127.0.0.1), публично `:443` (funnel,
  basicauth). Ссылки пульта относительные (`/wiki/`, `/ui/`) → работают и локально, и удалённо.
- **Open WebUI** — root-приложение, поэтому отдаётся отдельным портом funnel `:8443` (своя авторизация).
- **Funnel даёт только порты 443 / 8443 / 10000**, но на 443 Caddy разводит любое число сервисов по путям.
