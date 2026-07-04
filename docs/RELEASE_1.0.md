<p align="center">
  <img src="https://raw.githubusercontent.com/MikalaiKryvusha/KLAS/main/logo/KLAS_latest.jpg" alt="KLAS" width="600">
</p>

# KLAS 1.0 — Universal KLAS

**[English](#english) · [Русский](#русский)**

## English

A self-hosted AI ecosystem that lives entirely on your own PC — a local LLM on your gaming GPU,
autonomous agents in your editor, a web control panel, an offline Wikipedia, and a private chat for
your family. Nothing goes to the cloud. It sleeps until called, runs stably, and gets as close to the
feel of Claude AI as a single graphics card allows.

**Universal** means turnkey: one guided wizard takes anyone — even a first-timer — from `git clone`
to a living AI, and one local model serves the owner, their close ones, and the knowledge base at
once.

## Install in one command

```powershell
git clone https://github.com/MikalaiKryvusha/KLAS.git F:\KLAS
node F:\KLAS\tools\install.mjs
```

The multilingual wizard (RU/EN) detects your GPU / driver / Docker / disk, lets you pick models and
knowledge bases from the **live Kiwix catalog** (title, size, article count), downloads everything,
creates desktop shortcuts, and brings the whole stack up. It is foolproof and **survives reboots** —
stop and re-run anytime, it continues where it left off. `--yes` installs with recommended defaults.

## What you get

- **Local LLM on your GPU** — [llama.cpp](https://github.com/ggml-org/llama.cpp) (CUDA) managed by
  [llama-swap](https://github.com/mostlygeek/llama-swap): the model auto-loads on demand and unloads
  when idle. Main model **Qwythos-9B with a 256K context** (agent-bench 6/6, needle @148K); alternates
  (Qwen3.5-35B-A3B, Ornith-1.0-35B, Qwen3.6-27B, Gemma-4-12B multimodal) swap by name.
- **An agent in your editor** — Zoo Code (VS Code), locally and over the internet.
- **A chat for close ones** — [Open WebUI](https://github.com/open-webui/open-webui) with personal
  accounts and private chats; the model can search the local Wikipedia through a built-in Kiwix tool.
- **An offline knowledge base** — kiwix serving Wikipedia and other `.zim`, searchable both from the
  chat and by the agent (via MCP).
- **One control panel** — a homepage dashboard behind Caddy: a single entry point to the model UI, the
  wiki, and remote services, with one-click Run / Stop / Control-Panel desktop shortcuts and a tray
  controller.
- **Remote access** — an OpenAI-compatible API and the full web over the internet via
  Caddy + Tailscale Funnel; just a URL and a Bearer key.

## Privacy & control

- Your data never leaves the machine; the cloud is optional and the system works fully offline.
- It sleeps until called and doesn't consume resources while idle.
- The repository is only the frame — engine, models, `.zim`, and docker images are pulled at install
  time, never vendored. Secrets stay out of git.

## Requirements

Windows 11 · NVIDIA GPU (16 GB VRAM recommended) · Node ≥20 · git · winget · Docker (optional, for the
knowledge base and dashboard).

Managed by the human-visionary + AI-agent tandem on the
**[KAIF](https://github.com/MikalaiKryvusha/KAIF)** framework. License — MIT.

---

## Русский

Self-hosted экосистема агентского ИИ, целиком живущая на вашем ПК — локальная LLM на геймерской
видеокарте, автономные агенты в редакторе, веб-пульт, оффлайн-Википедия и приватный чат для родных.
Ничего не уходит в облако. Система «спит», пока не позвали, работает стабильно и максимально
приближается к ощущению Claude AI в пределах одной видеокарты.

**Universal** — значит под ключ: один мастер проводит любого, даже новичка, от `git clone` до живого
ИИ, а одна локальная модель обслуживает сразу владельца, его близких и базу знаний.

## Установка одной командой

```powershell
git clone https://github.com/MikalaiKryvusha/KLAS.git F:\KLAS
node F:\KLAS\tools\install.mjs
```

Мультиязычный мастер (рус/eng) определяет GPU / драйвер / Docker / диск, даёт выбрать модели и базы
знаний из **живого каталога Kiwix** (название, размер, число статей), всё скачивает, создаёт ярлыки на
Рабочем столе и поднимает стек. Он с защитой от дурака и **переживает перезагрузки** — можно прервать
и запустить снова, продолжит с места. Флаг `--yes` ставит с рекомендуемыми настройками.

## Что вы получаете

- **Локальная LLM на вашей GPU** — [llama.cpp](https://github.com/ggml-org/llama.cpp) (CUDA) под
  управлением [llama-swap](https://github.com/mostlygeek/llama-swap): модель поднимается по запросу и
  выгружается в простое. Основная — **Qwythos-9B с контекстом 256K** (agent-bench 6/6, needle @148K);
  запасные (Qwen3.5-35B-A3B, Ornith-1.0-35B, Qwen3.6-27B, Gemma-4-12B мультимодальная) свопятся по имени.
- **Агент в редакторе** — Zoo Code (VS Code), локально и через интернет.
- **Чат для родных** — [Open WebUI](https://github.com/open-webui/open-webui): личные аккаунты и
  приватные чаты; модель умеет искать по локальной Википедии встроенным инструментом Kiwix.
- **Оффлайн-база знаний** — kiwix отдаёт Википедию и другие `.zim`, поиск доступен и из чата, и агенту
  (через MCP).
- **Единый пульт** — дашборд homepage за Caddy: один вход к UI моделей, вики и удалённым сервисам,
  ярлыки Run / Stop / Control Panel и иконка в трее.
- **Удалённый доступ** — OpenAI-совместимый API и полноценный веб через интернет по
  Caddy + Tailscale Funnel; достаточно URL и Bearer-ключа.

## Приватность и контроль

- Данные не покидают машину; облако не обязательно, система полностью работает оффлайн.
- «Спит», пока не позвали, и не ест ресурсы в простое.
- Репозиторий — только каркас: движок, модели, `.zim` и docker-образы докачиваются при установке, в
  git не упаковываются. Секреты вне git.

## Требования

Windows 11 · NVIDIA GPU (16 ГБ VRAM рекоменд.) · Node ≥20 · git · winget · Docker (опционально — база
знаний и дашборд).

Разработкой рулит тандем «человек-визионер + ИИ-агент» на фреймворке
**[KAIF](https://github.com/MikalaiKryvusha/KAIF)**. Лицензия — MIT.
