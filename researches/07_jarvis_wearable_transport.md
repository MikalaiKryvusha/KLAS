# Research 07 — Связка «KLAS-хост ↔ Android-клиент ↔ носимое устройство»: транспорт и API Jarvis

> Живой справочник (тег `DONE` не ставится). Мотивирован вопросом владельца (2026-07-07): как связать
> ИИ-хост KLAS с носимым Android-клиентом Криника, и нужен ли «свой обширный кастомный API» для вывода
> [Jarvis](../ideas/05_Jarvis.md) наружу. Уровень — **гуглёж** (не глубинное исследование).
> План реализации — [plans/07_jarvis_gateway_and_client.md](../plans/07_jarvis_gateway_and_client.md).
> Дата: 2026-07-07.

---

## 0. Прямой ответ на вопрос владельца

> «Полагаю, у KLAS нужно делать свой кастомный обширный API… Возможно, я заблуждаюсь».

**Ты прав наполовину — и это важная половина.** Да, нужен **чёткий API-шлюз** («Jarvis Gateway»), через
который Jarvis выходит наружу к носимому клиенту: без границы клиент не подключить. **Но «обширный
кастомный API» — это ловушка (против принципа простоты KLAS).** Правильно — **тонкий, событийный,
реального времени** шлюз, форма которого копирует уже сложившиеся стандарты (OpenAI Realtime / Wyoming),
а тяжёлое переиспользуется из того, что в KLAS **уже есть**:

- **Транспорт наружу уже решён — Tailscale** (в KLAS развёрнут funnel/tailnet). Носимый Android входит в
  тот же tailnet → защищённый прямой канал устройство↔хост (WireGuard, обход NAT) **без публичного
  выставления Jarvis в интернет**. Это снимает 80% «кастомного API про доступ и безопасность».
- **LLM-API уже есть** — llama-server отдаёт OpenAI-совместимый `/v1` (llama-swap на 8080). Jarvis его
  переиспользует внутри, не изобретая.
- Остаётся дописать **немного**: (1) **realtime-сессия голоса** (WS/WebRTC: стрим микрофона → ответ
  голосом), (2) **маленький control-API** (навыки, конфиг, память, персона Jarvis/Joi). Всё.

**Вывод:** не «обширный API», а **тонкий Jarvis Gateway из двух поверхностей** поверх существующей
инфраструктуры. Обширным он станет сам, органически, по мере добавления навыков — но ядро транспорта
маленькое и стандартное.

---

## 1. Карта связки (4 слоя)

```
[1] Носимое устройство            [2] Android-клиент            [3] Транспорт        [4] KLAS-хост (Jarvis)
    BT-гарнитура / AR-очки            (телефон Криника)             (Tailscale)          RTX 5070 Ti
    ───────────────────               ─────────────────            ──────────          ──────────────────
    • микрофон  ──audio──►    • захват аудио (BT SCO/A2DP)   ──WireGuard──►   • Jarvis Gateway (сессии)
    • динамики  ◄─audio──     • wake word «Jarvis»/«Joi»       защищ. канал     • STT (Whisper streaming)
                              • VAD / barge-in                  в tailnet       • LLM (llama-server /v1) ✅
                              • foreground service              (обход NAT,      • TTS (Piper / голос Вихрова/Joi)
                              • стрим сессии на хост            без публ. IP)    • роутер навыков + память
                              • проигрывание TTS-ответа                          • (PAI-протоколы — idea PAI)
```

- **[1] Носимое** — «тупой» аудио-периферал (мик + динамики). Вся логика — на телефоне и хосте. AR-очки
  или BT-гарнитура — эквивалентны с точки зрения архитектуры (источник/приёмник звука).
- **[2] Android-клиент** — самый недооценённый и самый сложный по «мобильным» нюансам слой (см. §4).
  Именно он делает опыт «Joi всегда рядом»: локальный wake word, тихий фон, мгновенный старт сессии.
- **[3] Транспорт** — Tailscale уже в KLAS. Устройство Криника = узел tailnet ⇒ прямой зашифрованный
  линк. Публичный funnel для голоса Jarvis НЕ нужен (и не желателен — приватность).
- **[4] Хост** — «мозг». Здесь Jarvis Gateway дирижирует STT→LLM→TTS + навыки + память + (в будущем) PAI.

## 2. Пайплайн голоса: каскад (STT→LLM→TTS) vs speech-to-speech

| Подход | Что | Для KLAS |
|--------|-----|----------|
| **Каскад STT→LLM→TTS** | 3 модели: распознавание → рассуждение → синтез | ✅ **рекомендуется**: Whisper(.cpp) + llama-server(уже есть) + Piper/своя TTS. Реалистично на локальной GPU, полный контроль, части заменяемы |
| **Speech-to-speech (единая модель)** | Одна модель аудио→аудио (как gpt-realtime) | ⏳ ниже задержка и лучше интонация, НО локальные S2S-модели — bleeding edge, тяжёлые, незрелые. Задел на будущее, не сейчас |

**Ключ к «живости» (из idea 05 «незамедлительно начал отвечать, пока думаю»):** **стриминг + barge-in**.
- Стримить на каждом шаге: частичный STT → начать думать/искать → начать говорить первые слова TTS, пока
  генерируется остаток. Не ждать полной фразы.
- **Barge-in** — пользователь перебивает голосом, ассистент немедленно замолкает и слушает. Обязательно
  для ощущения «как с живым человеком».

## 3. Транспорт: WebRTC vs WebSocket (главная развилка транспорта)

Гуглёж (LiveKit, OpenAI, WebRTC.ventures) сходится однозначно для **голоса в движении**:

| | WebSocket (поверх TCP) | **WebRTC (поверх UDP)** |
|--|------------------------|-------------------------|
| Задержка | выше; **head-of-line blocking** при потере пакета (TCP ждёт ретрансмит — для аудио губительно) | **60–120 мс mouth-to-ear**, приоритет свежести над полнотой |
| Сеть в движении | плохо переносит скачки/потери сотовой сети | **адаптация к сети, jitter buffer, NAT traversal — из коробки** |
| Бонусы | простой, легко на сервере | **эхоподавление, шумоподавление** встроены |
| Сложность | низкая | выше (SDP/ICE, но есть готовые: LiveKit, Pipecat, aiortc) |

**Рекомендация (прагматично, по фазам):**
- **Прототип (дома, в tailnet/LAN):** **WebSocket** — проще всего поднять, стрим аудио + событий, хватает
  для отладки пайплайна и навыков.
- **Прод «гуляю по городу» (сотовая сеть):** **WebRTC** для аудио (устойчивость и задержка), WebSocket
  для управляющих событий. Классика 2025–2026: «WebRTC от клиента до relay, WebSocket от сервера до
  модели». Не тащить WebRTC раньше, чем понадобится мобильная устойчивость.

## 4. Android-клиент: мобильные нюансы (недооценённый слой)

Именно тут прячется реальная сложность «носимого Jarvis»:

- **Wake word — на устройстве, не на хосте.** Постоянно стримить микрофон на хост — это батарея и трафик.
  Правильно (как в Home Assistant Companion App): **on-device wake word** (microWakeWord/openWakeWord),
  сессия на хост открывается **только после** «Jarvis»/«Joi». Даёт приватность и автономность (реагирует
  даже при плохой сети).
- **Foreground service обязателен.** Android 14+ требует явный `foregroundServiceType`. Для нашего кейса:
  `microphone` + `connectedDevice` (BT-гарнитура). Без корректного FGS система убьёт фоновое прослушивание.
- **Bluetooth-аудио:** захват микрофона гарнитуры — профиль **HFP/SCO** (узкополосный, но с микрофоном);
  воспроизведение — **A2DP** (широкополосный, только вывод). Переключение SCO↔A2DP — известная боль;
  заложить в план.
- **Батарея:** always-on wake word держит гарнитуру/телефон «бодрыми» → расход. Компромиссы: лёгкий
  on-device детектор, кнопка на гарнитуре как альтернатива wake word, тайм-ауты сессии.
- **Свой клиент vs готовый:** можно (а) писать свой Android-клиент; (б) форкнуть/переиспользовать **Home
  Assistant Companion App** (уже умеет wake word + Assist pipeline + аудио) как референс или базу.
  Решить в плане.

## 5. Готовые экосистемы — что заимствовать (принцип «бери лучшее»)

| Проект | Что даёт | Как использовать в KLAS |
|--------|----------|--------------------------|
| **Wyoming protocol** (Home Assistant / Rhasspy) | Простой протокол «спутник↔сервер» для STT/TTS/wake, стрим аудио | **Референс формата** событий и разделения «satellite (телефон) ↔ сервер». Возможно — прямая совместимость |
| **wyoming-satellite** | Готовый «голосовой спутник» | Референс клиента; идеи по VAD/стримингу |
| **HA Companion App (Android)** | On-device wake word, Assist pipeline, аудио, FGS | Референс или база Android-клиента |
| **Pipecat** (Python) | Dataflow-фреймворк голосовых агентов (frame processors), стрим, barge-in | Каркас оркестрации пайплайна на хосте (если Node неудобен для realtime-аудио) |
| **LiveKit** (+ Agents) | WebRTC-инфраструктура (SFU) + голосовые агенты | Транспорт WebRTC «под ключ», когда дойдём до мобильного прода |
| **Willow** | Self-hosted голосовой ассистент, p2p-протокол | Референс архитектуры/тредоффов |
| **Whisper.cpp / faster-whisper** | Локальный STT, стриминг | Слой STT каскада |
| **Piper** (Rhasspy) | Быстрый локальный neural TTS | Слой TTS (пока не готов голос Вихрова/Joi); голоса — обучаемы (см. idea 05) |

> ⚠️ Лицензии/стек: часть — Python (Pipecat, whisper, piper). Приоритет KLAS — Node, но для realtime-аудио
> и ML Python часто нативнее (заметка владельца это допускает). Транспорт/оркестрацию realtime разумно
> делать там, где экосистема зрелее; control-API и интеграцию с llama-server — на Node.

## 6. Форма Jarvis Gateway (тонкая, стандартная — НЕ «обширная»)

Две поверхности, обе маленькие:

**A. Realtime Voice Session** (WS в прототипе → WebRTC в проде), событийная, по образу OpenAI Realtime /
Wyoming:
- клиент→хост: `session.start` (персона Jarvis/Joi, язык), `audio.chunk` (стрим PCM/opus), `barge_in`, `session.stop`
- хост→клиент: `stt.partial/final`, `assistant.text.delta`, `audio.chunk` (TTS-стрим), `skill.invoked`, `error`
- Одна долгоживущая сессия = одно «состояние разговора» (stateful), как Realtime Session у OpenAI.

**B. Control API** (маленький REST/JSON, поверх tailnet):
- навыки (CRUD — из idea 05), выбор персоны (Jarvis/Joi), конфиг голоса, доступ к памяти Jarvis,
  запуск PAI-протоколов (idea PAI). Переиспользует внутри существующий llama `/v1`.

**Чего НЕ делать:** не выставлять Jarvis в публичный интернет (только tailnet); не плодить эндпоинты «на
всякий случай»; не изобретать формат событий — копировать сложившийся (Realtime/Wyoming), чтобы будущие
клиенты (веб-пульт, второй телефон, AR-очки) подключались легко.

## 7. Безопасность и приватность
- **Только tailnet, без публичного funnel для голоса** — Jarvis слышит микрофон и управляет ПК (idea 05),
  это интимный и мощный доступ; наружу его не выставляем. Устройство аутентифицировано как узел tailnet.
- Bearer-ключ как второй фактор на control-API (у KLAS уже есть практика ключей в `caddy/PASSWORD.local.txt`).
- Данные (голос, транскрипты, память) не покидают хост — соответствует стержню KLAS (полная приватность).

## 8. Открытые вопросы (для `/interview` перед реализацией)
1. **Клиент:** свой Android-клиент с нуля или база на HA Companion App?
2. **Оркестрация на хосте:** Node (ближе к KLAS) или Python/Pipecat (зрелее для realtime-аудио)?
3. **Транспорт прототипа:** сразу WebRTC (LiveKit) или начать с WebSocket и мигрировать?
4. **STT/TTS:** Whisper.cpp + Piper на старте (голоса Вихрова/Joi — обучить позже) — ок?
5. **Wake word:** on-device детектор (какой) + запасная кнопка на гарнитуре?

## Источники (гуглёж 2026-07-07)
- [Wyoming Protocol (Home Assistant)](https://www.home-assistant.io/integrations/wyoming/) · [wyoming-satellite](https://github.com/rhasspy/wyoming-satellite) · [HA wake word](https://www.home-assistant.io/voice_control/about_wake_word/)
- [Why WebRTC beats WebSockets for realtime voice AI (LiveKit)](https://livekit.com/blog/why-webrtc-beats-websockets-for-voice-ai-agents) · [Why WebRTC is best transport (WebRTC.ventures)](https://webrtc.ventures/2025/10/why-webrtc-is-the-best-transport-for-real-time-voice-ai-architectures/)
- [OpenAI: delivering low-latency voice AI at scale](https://openai.com/index/delivering-low-latency-voice-ai-at-scale/) · [Realtime API (OpenAI docs)](https://developers.openai.com/api/docs/guides/realtime) · [Realtime API: The Missing Manual (latent.space)](https://www.latent.space/p/realtime-api)
- [Real-time vs turn-based voice agents (Softcery)](https://softcery.com/lab/ai-voice-agents-real-time-vs-turn-based-tts-stt-architecture)
- [Foreground services on Android 14 (Medium)](https://medium.com/@domen.lanisnik/guide-to-foreground-services-on-android-9d0127dc8f9a) · [BluetoothHeadset (Android)](https://developer.android.com/reference/android/bluetooth/BluetoothHeadset)
- [Pipecat](https://github.com/pipecat-ai/pipecat) · [LiveKit Agents](https://livekit.io/) · Willow · Whisper.cpp · Piper (Rhasspy)
