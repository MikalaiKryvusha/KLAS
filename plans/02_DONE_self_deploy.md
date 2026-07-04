# План 02 — Самораскрытие KLAS: «git clone + node tools/deploy.mjs» (идея 03)

> Реализует `ideas/03_klas_single_unit_self_deploy.md`. Статус: ✅ DONE (2026-07-04) — движок
> `tools/deploy.mjs` + манифест построены, идемпотентны, в проде (использует мастер `install.mjs`).
> Интерактивная обёртка «под ключ» — план 05; полный прогон с чистой машины — там же (Ф6).
> Репозиторий — каркас/обёртка/фрейм; всё тяжёлое deploy скачивает сам.

## Цель

На чистом ПК (Windows 11 + NVIDIA GPU) владелец выполняет ДВЕ команды:

```powershell
git clone https://github.com/MikalaiKryvusha/KLAS.git F:\KLAS
node F:\KLAS\tools\deploy.mjs        # dry-run: печатает план
node F:\KLAS\tools\deploy.mjs --apply
```

— и получает работающий KLAS: движок, модель, llama-swap («спит, пока не позовут»), docker-сервисы
(kiwix/homepage/caddy), профили и харнесс. Повторный запуск на живой системе — безвреден
(идемпотентность: дотягивает недостающее, ничего не перекачивает зря).

## Архитектура: манифест + скачиватель

**Один источник правды — `tools/deploy.manifest.json`** (в git): что нужно, откуда качать, чем
проверять, куда класть:

```json
{
  "llamacpp":  { "kind": "github-release", "repo": "ggml-org/llama.cpp",
                 "asset": "llama-<build>-bin-win-cuda-x64.zip", "pin": "b9538",
                 "dest": "llamacpp/", "check": "llamacpp/llama-server.exe --version" },
  "model-gemma-4-12b": { "kind": "hf-file", "repo": "unsloth/gemma-4-12b-it-GGUF",
                 "file": "gemma-4-12b-it-UD-Q4_K_XL.gguf", "sha256": "<хеш>",
                 "dest": "LLMs/LLAMACPP_MODELS/" },
  "llama-swap": { "kind": "winget", "id": "mostlygeek.llama-swap" },
  "docker-stack": { "kind": "compose", "file": "docker-compose.yml" },
  "kiwix-zim":  { "kind": "url", "url": "https://download.kiwix.org/zim/wikipedia/<файл>.zim",
                 "dest": "kiwixdb/", "optional": true }
}
```

`tools/deploy.mjs` (чистый Node, zero-deps, как kaif.mjs):
1. **Предпроверки:** node ≥20, git, winget; NVIDIA-драйвер (`nvidia-smi`); docker (опционален —
   без него пропускаем docker-стек с предупреждением); свободное место на диске.
2. **По манифесту:** для каждого элемента — «уже есть и проходит check?» → пропустить; иначе
   скачать (с прогрессом и докачкой), проверить sha256, распаковать/установить.
3. **Пост-настройка:** прописать llama-swap автозапуск (Task Scheduler / nssm — выбрать в ходе
   Фазы 4); `docker compose up -d`; финальный `tools/health-check.ps1` + тестовый запрос к модели.
4. **Отчёт:** что поставлено/пропущено/провалено, следующие шаги.

## Принципы (из идеи 03 и PHILOSOPHY)

- **Идемпотентность** — главный инвариант: каждый шаг сначала проверяет «уже сделано?».
- **Dry-run по умолчанию**, `--apply` для выполнения (паттерн проверен миграцией).
- **Пины версий** в манифесте (llama.cpp build, sha256 модели) — воспроизводимость; обновление
  пинов — осознанный коммит.
- **Текущая машина — первый полигон:** deploy на уже развёрнутом F:\KLAS должен пройти в
  «всё уже есть» без единого скачивания.
- Секреты (пароль caddy basicauth) НЕ в git: deploy запрашивает/генерирует при установке.

## Шаги реализации (беклог)

- [x] 1. `deploy.manifest.json` ✅ (2026-07-03): llama.cpp b9538 (ассеты win-cuda-13.3 пришпилены
        через gh api), модель gemma sha256+размер, llama-swap winget, docker-compose.
- [x] 2. `deploy.mjs` каркас ✅ (2026-07-03): манифест, dry-run/--apply, предпроверки
        (node/winget/docker/nvidia), обработчики `github-release`, `url` (докачка .part + sha256).
- [x] 3. Обработчики `winget` и `compose` ✅; пост-настройка/финальный health-check — TODO.
- [x] 4. Полигон-тест (dry-run) ✅: живая система распознана целиком, ноль скачиваний.
        `--apply`-прогон на живой системе — тоже безвреден, но ещё не гонялся.
- [ ] 5. (Когда будет доступ к чистой машине/VM — домашка владельцу) полный тест с нуля.
- [ ] 6. README: секция «Развернуть на новом ПК» (две команды).

## Открытые вопросы

- Автозапуск llama-swap: Task Scheduler (проще) vs nssm-сервис (надёжнее, авторестарт) — решить
  при реализации Фазы 4; сейчас llama-swap запускается вручную.
- .zim википедии: какой набор качать по умолчанию (см. также интервью 001 Q4 про docker-сервисы).
- Модель(и) по умолчанию в манифесте — итог Фазы 2b (бенчи кандидатов).
