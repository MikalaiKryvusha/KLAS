<p align="center">
  <img src="logo/KLAS.jpg" alt="KLAS — Krinik Local Agent System" width="640">
</p>

<p align="center">
  <img src="logo/klas-cat.svg" alt="KLAS — Кот Криник (логотип)" width="128">
</p>

# KLAS — Krinik Local Agent System

<p align="center">
  <a href="#english"><img src="https://img.shields.io/badge/English-2C7BE5?style=for-the-badge" alt="English"></a>
  &nbsp;
  <a href="#русский"><img src="https://img.shields.io/badge/Русский-C0392B?style=for-the-badge" alt="Русский"></a>
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-FF1A8C.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-0.2-FF1A8C.svg)](https://github.com/MikalaiKryvusha/KLAS/releases)
[![Framework](https://img.shields.io/badge/Framework-KAIF-7F52FF.svg)](https://github.com/MikalaiKryvusha/KAIF)
[![Platform](https://img.shields.io/badge/Platform-Windows%2011-0078D6.svg)](#dom-sistemy)
[![GPU](https://img.shields.io/badge/GPU-RTX%205070%20Ti%2016%20GB-76B900.svg)](#what-is-inside)

---

<a name="english"></a>
## English · [Русский](#русский)

**KLAS — a self-hosted AI ecosystem on your own PC:** a local LLM on a gaming GPU, autonomous
agents, a web control dashboard, and an offline knowledge base (local Wikipedia). Total data
privacy, offline efficiency, and an experience as close to Claude AI as a single RTX 5070 Ti
16 GB allows. It sleeps until called, runs stably, and serves its owner and their close ones.

> 🐈 The cat on the banner is KOT KRINIK himself. He approves.

Deploy on a fresh PC in **two commands** — clone, then one deploy that pulls the heavy parts
(engine, models, docker images) by itself. The repository is the frame; nothing heavy is vendored.

### Why

- **Privacy** — your data never leaves the machine; the cloud is optional.
- **Offline** — the LLM, agents, and knowledge base work without the internet.
- **Your own server** — sleeps until called, doesn't eat resources while idle.
- **Priorities** (in this order): **stability → intelligence → speed**. Context-overflow errors are
  unacceptable on principle.

### What is inside

| Component | Current implementation | Role |
|-----------|------------------------|------|
| Inference engine | [llama.cpp](https://github.com/ggml-org/llama.cpp) (`llama-server`, CUDA) | LLM on the GPU |
| Model manager | [llama-swap](https://github.com/mostlygeek/llama-swap) — "sleeps until called" | auto load/unload by request, web UI at `/ui/` |
| Main model | **Qwythos-9B** (Q5_K_M) — **256K context** | the "brain" (agent-bench 6/6, needle @148K ✅) |
| Alt models | Qwen3.5-35B-A3B (smart MoE, 98K), Ornith-1.0-35B (SWE-bench 75.6), Qwen3.6-27B (64K), gemma-4-12b (131K, multimodal) | swapped by name |
| Agent frontend | Zoo Code (VS Code) — local & remote | the agent in the editor |
| Knowledge base | kiwix (local Wikipedia) + **openzim-mcp** search for the agent | offline knowledge for people & agents |
| Control panel | homepage (docker) + llama-swap UI | single entry point (Phase 5) |
| Dashboard | homepage (docker) + llama-swap UI | the "control panel" |
| Remote access | Caddy + Tailscale Funnel | OpenAI-compatible API over the internet |

### Deploy on a fresh PC

```powershell
git clone https://github.com/MikalaiKryvusha/KLAS.git F:\KLAS
node F:\KLAS\tools\deploy.mjs           # dry-run: prints the plan
node F:\KLAS\tools\deploy.mjs --apply   # deploy (pulls models & docker images)
```

Requirements: Windows 11, NVIDIA GPU (16 GB VRAM recommended), Node ≥20, git, winget;
docker optional (knowledge base + dashboard). Heavy artifacts (models, `.zim`, 3rd-party modules)
are **not** in the repo — they are pulled at deploy time.

**Anonymous install** (a de-identified copy — no author, no origin):

```powershell
node F:\KLAS\tools\anonymize.mjs --apply --reinit-git
```

### Remote access (Zoo Code from any computer)

An OpenAI-compatible endpoint over the internet — just a URL and an API key:

- **Base URL:** `https://<your-machine>.ts.net/llm/v1`
- **API Key:** a Bearer key (stored in `caddy/PASSWORD.local.txt`)
- **Model:** `qwythos-9b` (or `qwen3.5-35b` / `qwen3.6-27b` / `gemma-4-12b`)

### Roadmap

| Phase | What | Status |
|-------|------|--------|
| 0 · 0.5 | Foundation (KAIF, audit) · Birth of KLAS (name, home, logo) | ✅ |
| 1 | Stack stabilization (context-overflow bug) | ✅ |
| 2 | Optimal-stack research + local benchmarks | ✅ |
| 4 | "Sleeps until called" lifecycle (llama-swap + autostart) | ✅ |
| 5 | Control-panel dashboard + knowledge base | 🔧 |
| 6 | Daily driver, access for close ones | 🔲 |
| ✨ | Remote API access · anonymous deploy · Qwythos 256K | ✅ (0.1) |
| ✨ | Control panel · knowledge search for the agent (MCP) · Ornith-35B | ✅ (0.2) |

### Managed by KAIF

Development is run by the human-visionary + AI-agent tandem on the
**[KAIF](https://github.com/MikalaiKryvusha/KAIF)** framework. **KLAS ≠ KAIF:** KAIF is an
auxiliary dev framework deployed locally to help build KLAS — for KLAS it is a 3rd-party tool and is
**not** vendored into this repository.

---

<a name="русский"></a>
## Русский · [English](#english)

**KLAS — self-hosted экосистема агентского ИИ на личном ПК:** локальная LLM на геймерской GPU,
автономные агенты, веб-дашборд управления и оффлайн-база знаний (локальная википедия). Полная
приватность данных, оффлайн-эффективность и опыт, максимально близкий к Claude AI в пределах одной
RTX 5070 Ti 16 GB. Система «спит», пока не позвали, работает стабильно и служит владельцу и близким.

> 🐈 Кот на баннере — Кот Криник собственной персоной. Одобряет.

Развёртывание на чистом ПК — **две команды**: клон и один деплой, который сам докачивает тяжёлое
(движок, модели, docker-образы). Репозиторий — это каркас; ничего тяжёлого в него не упаковано.

### Зачем

- **Приватность** — данные не покидают машину; облако не обязательно.
- **Оффлайн** — LLM, агенты и база знаний работают без интернета.
- **Свой сервер** — «спит», пока не позвали, не ест ресурсы в простое.
- **Приоритеты** (в этом порядке): **стабильность → ум → скорость**. Ошибки переполнения контекста
  недопустимы в принципе.

### Что внутри

| Компонент | Текущая реализация | Роль |
|-----------|--------------------|------|
| Движок инференса | [llama.cpp](https://github.com/ggml-org/llama.cpp) (`llama-server`, CUDA) | LLM на GPU |
| Менеджер моделей | [llama-swap](https://github.com/mostlygeek/llama-swap) — «спит, пока не позовут» | автозагрузка/выгрузка по запросу, веб-UI на `/ui/` |
| Основная модель | **Qwythos-9B** (Q5_K_M) — **256K контекста** | «мозг» (agent-bench 6/6, needle @148K ✅) |
| Запасные модели | Qwen3.5-35B-A3B (умный MoE, 98K), Ornith-1.0-35B (SWE-bench 75.6), Qwen3.6-27B (64K), gemma-4-12b (131K, мультимодальная) | свопятся по имени |
| Агентский фронтенд | Zoo Code (VS Code) — локально и удалённо | агент в редакторе |
| База знаний | kiwix (локальная википедия) + поиск **openzim-mcp** для агента | оффлайн-знания людям и агентам |
| Дашборд | homepage (docker) + UI llama-swap | «пульт управления» (Фаза 5) |
| Удалённый доступ | Caddy + Tailscale Funnel | OpenAI-совместимый API через интернет |

### Развернуть на новом ПК

```powershell
git clone https://github.com/MikalaiKryvusha/KLAS.git F:\KLAS
node F:\KLAS\tools\deploy.mjs           # репетиция: печатает план
node F:\KLAS\tools\deploy.mjs --apply   # развёртывание (докачивает модели и docker-образы)
```

Требования: Windows 11, NVIDIA GPU (16 ГБ VRAM рекоменд.), Node ≥20, git, winget; docker —
опционально (база знаний + дашборд). Тяжёлое (модели, `.zim`, сторонние модули) в репозиторий **не**
входит — докачивается при развёртывании.

**Анонимная установка** (обезличенная копия — без автора и origin):

```powershell
node F:\KLAS\tools\anonymize.mjs --apply --reinit-git
```

### Удалённый доступ (Zoo Code с любого компьютера)

OpenAI-совместимая точка входа через интернет — достаточно URL и API-ключа:

- **Base URL:** `https://<ваша-машина>.ts.net/llm/v1`
- **API Key:** Bearer-ключ (хранится в `caddy/PASSWORD.local.txt`)
- **Модель:** `qwythos-9b` (или `qwen3.5-35b` / `qwen3.6-27b` / `gemma-4-12b`)

### Дорожная карта

| Фаза | Что | Статус |
|------|-----|--------|
| 0 · 0.5 | Фундамент (KAIF, аудит) · Рождение KLAS (имя, дом, логотип) | ✅ |
| 1 | Стабилизация стека (баг переполнения контекста) | ✅ |
| 2 | Исследование оптимального стека + локальные бенчи | ✅ |
| 4 | Жизненный цикл «спит, пока не позовут» (llama-swap + автостарт) | ✅ |
| 5 | Веб-дашборд «пульт» + база знаний | 🔧 |
| 6 | Ежедневная работа, доступ близким | 🔲 |
| ✨ | Удалённый API-доступ · анонимный деплой · Qwythos 256K | ✅ (0.1) |
| ✨ | Пульт управления · поиск по базе знаний для агента (MCP) · Ornith-35B | ✅ (0.2) |

### Управляется через KAIF

Разработкой рулит тандем «человек-визионер + ИИ-агент» на фреймворке
**[KAIF](https://github.com/MikalaiKryvusha/KAIF)**. **KLAS ≠ KAIF:** KAIF — вспомогательный
dev-фреймворк, развёрнутый локально в помощь разработке KLAS; для KLAS он 3rd-party-инструмент и в
этот репозиторий **не** упаковывается.

---

## Author · Автор

© 2026 **Mikalai Kryvusha** aka **KOT KRINIK** · Николай Кривуша aka Кот Криник

License · Лицензия — [MIT](LICENSE).
