# KLAS — Krinik Local Agent System — Внешняя карта структуры

> **ВНЕШНЯЯ карта: как проект выглядит снаружи** — директории, файлы, перекрёстные ссылки и зависимости
> между ними. Это карта «где что лежит», по которой ориентируется свежая сессия. Её напарник —
> `PROJECT_ARCHITECTURE_INTERNAL_MAP.md` (*внутренняя* логическая архитектура — абстракции и их
> взаимодействие). Держи в согласии с реальным деревом. **Живой справочник — никогда не DONE.**

---

## Дерево

> 🏠 **Дом системы — `F:\KLAS\`**: корень = git-репозиторий-каркас (документы, конфиги, скрипты),
> инфраструктура — поддиректории рядом, вне git (идея 03: репозиторий — обёртка/фрейм, тяжёлое
> скачивается при развёртывании).

### Проект (корень репозитория)

```
<корень: F:\KLAS\ (git-репозиторий)>/
├── AGENT_GUIDE.md                       # канон: правила, команды, конвенции — читать перед каждой задачей
├── PHILOSOPHY.md                        # как мыслит агент (KISS + Оккам + набор принципов)
├── BUG_FIXING_FRAMEWORK.md              # как агент чинит дефекты
├── GOAL.md                              # видение владельца (его документ)
├── STATUS.md                            # живое состояние — обновляется после каждой значимой задачи
├── MASTER_PLAN.md                       # фазовая дорожная карта GOAL → реальность
├── PROJECT_STRUCTURE_EXTERNAL_MAP.md    # этот файл
├── PROJECT_ARCHITECTURE_INTERNAL_MAP.md # внутренняя карта: абстракции и взаимодействия
├── KAIF_FRAMEWORK.md                    # «KAIF, развёрнутый здесь» — человеко-читаемое описание
├── CLAUDE.md                            # автозагружаемый контекст Claude Code → указывает на AGENT_GUIDE.md
├── AGENTS.md                            # универсальный fallback для других агентских систем
├── README.md                            # витрина репозитория: бейджи, логотип, дорожная карта
├── LICENSE                              # MIT (© 2026 Mikalai Kryvusha) — выбор владельца
├── logo/                                # бренд-ассеты: KLAS.jpg (OG 1200×630, hero README), исходники
├── package.json                         # kaif:* handles (npm run kaif:version / kaif:check / kaif:update)
├── .kaif/kaif.json                      # маркер деплоя KAIF: версия, сфера, язык, агент-системы, tracking
├── .kaif/kaif-core.mjs                  # машинерия KAIF 2.1 — реализация npm run kaif:* (заменила tools/kaif.mjs)
├── .kaif/deploy-manifest.json           # sha256-слепки развёрнутых файлов (по ним update отличает нетронутое от разошедшегося)
├── .kaif/spheres/                       # библиотеки сфер (терминология + дисциплина исполнения домена)
├── .claude/skills/<name>/SKILL.md       # 34 скилла-ритуала (/resume, /pause, /end-chat, циклы, fable-*, лестница планирования)
├── .roo/ .agents/ .grok/ .cline/        # те же скиллы для Zoo Code / Codex / Grok Build / Cline (копии канона)
├── tools/                               # инструменты проекта и скрипты харнесса
│   ├── voice-say.mjs voice-hear.mjs voice-talk.mjs voice-bench.mjs voice-roundtrip.mjs
│   │                                    #   голосовой тракт: рот · уши · диалог · бенч · round-trip
│   ├── dry-run-guard.mjs                #   охранник класса: dry-run-инструмент вызван без --apply (bugs/23)
│   └── voice/                           # внутренности тракта (общий код + питон-сайдкары)
│       ├── pipeline.mjs                 #   ОДИН конвейер хода для диалога И бенча (не копия!)
│       ├── tts-daemon.mjs               #   Node-обёртка резидентного рта + канарейка кодировки
│       ├── silero_daemon.py             #   резидентный двуязычный синтез + нормализация чисел/единиц
│       ├── silero_say.py                #   разовый синтез (им пользуется TTS-провайдер ядра)
│       ├── pitch-check.py               #   охранник единства голоса (F0 русского и английского)
│       ├── single-instance.mjs          #   замок: динамики — один потребитель
│       ├── build-piper-dataset.mjs      #   сборка обучающего корпуса из длинной записи (нарезка + уши)
│       ├── piper-dataset-guard.mjs      #   охранник корпуса: снимает символы, специальные для csv.reader (bugs/18)
│       ├── train_piper.py               #   дообучение Piper VITS от чекпойнта-донора (warmstart, НЕ ckpt_path)
│       ├── train_vihrov.sh              #   запуск обучения одной командой (только из PowerShell — см. 9.5)
│       └── piper_audition.py            #   обученный голос → .onnx → пять текстов кастинга на выслушку
├── .gitattributes                       # окончания строк, где они условие работоспособности: *.sh=LF, *.bat=CRLF
├── openclaw/      # конфиг агентного ядра ассистента (шаблон openclaw.json.example + README;
│                  #   рабочая копия — ~/.openclaw/openclaw.json, вне git; план — plans/10)
├── plans/         # детальные планы шагов (реализация фаз MASTER_PLAN)     + README.md
├── ideas/         # предложения фич/улучшений (в основном от владельца)    + README.md
├── bugs/          # один документ на дефект                                + README.md
│   └── 01_context_overflow_zoo_code.md  # 🔴 переполнение контекста в Zoo Code
├── researches/    # база знаний по большим сложным вопросам               + README.md
│   └── 01_local_nomad_audit.md          # аудит окружения при деплое KAIF (историческая база знаний)
├── interviews/    # вопросы A/B/C/D владельцу                             + README.md
│   └── interview_001_project_setup.md   # 🟡 лицензия / автономия / docker-сервисы
└── homeworks/     # задачи от агента человеку                             + README.md
```

Идеи: `ideas/02_DONE_klas_logo_og.md` (✅ OG-логотип — результат в `logo/KLAS.jpg`),
`ideas/03_klas_single_unit_self_deploy.md` (каркас + самораскрытие «clone + deploy»),
`ideas/04_DONE_forget_local_nomad.md` (✅ фокус на видении), `ideas/05_Jarvis.md` (💡 голосовой
ассистент, на будущее). В корне также ассеты владельца: `8O-T3TotiIs.jpg`, `KLAS_LOGO_GOAL.txt`.

### Инфраструктура (поддиректории `F:\KLAS\`, вне git — кроме текстовых конфигов, см. `.gitignore`)

| Путь | Что это | Связи / заметки |
|------|---------|-----------------|
| `llamacpp\` | CUDA-сборка llama.cpp: `llama-server.exe`, `llama-bench.exe`, `llama-cli.exe`, dll CUDA 13 | движок текущего стека |
| `llamacpp\bat\gemma4-12b.bat` | текущий профиль запуска LLM-сервера (⚠️ `-c 256000`, порт не задан → 8080 по умолчанию) | использует модель из `LLMs\`; фигурант бага 01 |
| `LLMs\LLAMACPP_MODELS\` | GGUF: `gemma-4-12b-it-UD-Q4_K_XL.gguf` (~7.4 GB), `Qwen3.6-27B-UD-Q4_K_XL.gguf` (~17.9 GB — целиком в 16 GB VRAM не влезает) | модели движка |
| `docker-compose.yml` | сервисы: kiwix (**:8080**), homepage (:3005), caddy (:80/:443); блок anythingllm закомментирован | ⚠️ kiwix конкурирует за порт 8080 с llama-server |
| `homepage\`, `caddy\`, `kiwixdb\` | данные/конфиги docker-сервисов | тома compose |
| `voice\venv\` | Python-venv голосового тракта (torch + Silero) | его питоном запускаются оба сайдкара; путь зашит в `tools/voice/tts-daemon.mjs` и `tools/voice-say.mjs` |
| `voice\models\v5_ru.pt` · `v3_en.pt` | веса Silero TTS (русская + английская) | ⚠️ `v3_en.pt` питоном не скачать — у `models.silero.ai` истёк SSL-сертификат; добыт `Invoke-WebRequest` |
| `voice\models\gigaam-v3-ctc\` | УШИ по умолчанию (`--model ru`): NeMo-CTC, **34 токена** — только строчная кириллица | SOTA по чистому русскому, но БЕЗ пунктуации и БЕЗ латиницы (`bugs/10`) |
| `voice\models\gigaam-v3-ctc-punct\` | УШИ-опция (`--model punct`): тот же GigaAM-v3, **257 токенов** — латиница, пунктуация, заглавные, «ё» | развёрнута 2026-07-29, **дефолтом НЕ стала** — ждёт вердикта владельца (`bugs/10`) |
| `voice\out\` · `voice\bench\` | wav диалога и бенча (вне git) | ⚠️ **это криминалистика:** файлы переживают сессию, именно они доказали `bugs/08`. Здесь же замок `.voice-session.lock` |
| `voice\out\candidates\<ПЕРСОНА>\` | **выдача владельцу на выслушку**: по ОДНОМУ файлу на вариант, все пять текстов кастинга подряд, громкость выровнена к −14 LUFS | форма задана владельцем дословно. У JARVIS: одобренный `espeech_bystree.mp3` + `piper_vihrov*.mp3` (обученный Piper) |
| `voice\dataset_vihrov\` · `/opt/dataset_vihrov` (WSL) | обучающий корпус: 1185 реплик (~60 мин) + `metadata.csv` | ⚠️ боевой — тот, что в `/opt` (чтение через `/mnt` роняло загрузку GPU до 26%). Рядом `metadata.csv.before-guard` — состояние до лечения `bugs/18` |
| `/opt/piper1-gpl` · `/opt/piper_train/vihrov` · `/opt/piper_ckpt` (WSL) | обучатель Piper с venv (Python 3.11, torch 2.13.0+cu130), выход обучения (чекпойнты + `config.json`), чекпойнт-донор `ru_RU/ruslan/medium` | venv собран через `uv`, **pip внутри нет**; ставить `uv pip install --python /opt/piper1-gpl/.venv/bin/python <пакет>` |
| `mcp\web-search-mcp-v0.3.2\` | MCP-сервер веб-поиска | потенциальный инструмент для локального агента |
| `nssm\` | Non-Sucking Service Manager | кандидат для «спит, пока не позовут» (Фаза 4) |
| `tailscale_funnel_443.bat` | внешний доступ через Tailscale Funnel | Фаза 6 (доступ близким) |

> Наследие вне KLAS: в `F:\LOCAL_NOMAD\` остались `AnythingLLM`, `LLMs\OLLAMA_MODELS` (~46 ГБ;
> ⚠️ ollama автозапускается при старте ПК), `1.txt` (bcrypt-хеш). Судьба решается владельцем —
> вопросы в `ideas/03_klas_single_unit_self_deploy.md`.

## Правила перекрёстных ссылок и зависимостей

- Документы проекта ссылаются друг на друга свободно; **канон значений** (пути, порты, команды) — в
  `AGENT_GUIDE.md` и этих картах: другие документы ссылаются на них, а не дублируют (DRY).
- `GOAL.md` → определяет `MASTER_PLAN.md` → определяет `plans/NN_*.md`. Поток однонаправленный.
- Инфраструктурные поддиректории проект меняет только точечно и с фиксацией изменения в документах
  (например, правка `gemma4-12b.bat` — через баг 01 с записью «что и почему поменяли»).
- Генерируемые/скачиваемые артефакты (модели GGUF) в git НЕ попадают — репозиторий только для
  документов, конфигов и скриптов.

## Точки входа

1. `AGENT_GUIDE.md` — правила и команды (агенту — всегда первым).
2. `STATUS.md` — где мы и что дальше.
3. `GOAL.md` → `MASTER_PLAN.md` — зачем и куда идём.
4. `researches/01_local_nomad_audit.md` — что лежит в окружении и в каком состоянии.

---

> Держи карту честной: добавил, переместил или переименовал файл/директорию — обнови дерево и таблицу
> тем же изменением. *Внутренняя* логика (абстракции, потоки) — в
> `PROJECT_ARCHITECTURE_INTERNAL_MAP.md`.
