# Домашка 01 — Настроить удалённый доступ к KLAS в Zoo Code (с любого компьютера)

> Реализует `ideas/07` (удалённый доступ). Инфраструктура настроена агентом 2026-07-03 и проверена
> боем. От тебя — вписать настройки в Zoo Code на удалённой машине. Статус: 🟢 готово к использованию.

## Что уже сделано (агент)

- Caddy проксирует LLM-API наружу по пути `/llm/*` → llama-swap на домашнем ПК (порт 8080).
- Авторизация — по **Bearer API-ключу** (как и ждёт любой OpenAI-клиент), не по логину Tailscale.
- Tailscale Funnel уже отдаёт публичный HTTPS-URL. Проверено: без ключа `/llm` → 401, с ключом →
  модели и чат работают; википедия и homepage остались под отдельным логином/паролем (basicauth).

## Настройки Zoo Code (провайдер «OpenAI Compatible»)

| Поле | Значение |
|------|----------|
| **Base URL** | `https://krinikspc.forest-ratio.ts.net/llm/v1` |
| **API Key** | смотри `caddy/PASSWORD.local.txt` (строка «LLM API … API Key (Bearer)») |
| **Model** | `qwythos-9b` (256K контекста — рекомендуется), либо `qwen3.5-35b` / `qwen3.6-27b` / `gemma-4-12b` |
| **Context / max tokens** | под выбранную модель (qwythos ≤ 256000, qwen3.5 ≤ 98000, qwen3.6 ≤ 64000) |

Достаточно знать URL и ключ — логиниться в Tailscale на удалённой машине НЕ нужно (Funnel публичный).

## Проверка (с любого устройства)

```bash
curl -H "Authorization: Bearer < КЛЮЧ >" https://krinikspc.forest-ratio.ts.net/llm/v1/models
```
Должен вернуться список моделей. Если 401 — ключ неверный; если не отвечает — на домашнем ПК не
запущены Tailscale / Caddy / llama-swap (см. `tools/health-check.ps1` и `docker ps`).

## Безопасность

- ⚠️ Funnel — это ПУБЛИЧНЫЙ интернет. Доступ к GPU защищён Bearer-ключом (40 символов) — не потеряй
  и не публикуй его. Захочешь сменить — новый ключ в `caddy/Caddyfile` (поле `Bearer ...`) и в
  `PASSWORD.local.txt`, затем `docker restart caddy`.
- Хочешь совсем закрыть удалённый доступ — `tailscale funnel off` (или выключи Tailscale).
