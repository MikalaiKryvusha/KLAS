# План 12 — Голосовой тракт Г2: «Уши» — русский STT (sherpa-onnx + GigaAM-v3)

> Фаза Г2 голосового блока. Зонтик — [plans/07](07_jarvis_gateway_and_client.md), предыдущая —
> [Г1 «Голос»](11_voice_g1_tts_silero.md). Решения: интервью 004 (sherpa-onnx + GigaAM-v3 вместо
> Whisper.cpp — SOTA по русскому, MIT, стриминг, нативно Windows).
> Статус: ✅ **ГОТОВА (2026-07-17)** — round-trip 97% (критерий ≥90% взят), RTF 0.032.
> Тег DONE не ставим, пока владелец не прогонит вживую (файл переименуем при закрытии).

## Цель

KLAS **понимает русскую речь локально**: `node tools/voice-hear.mjs <файл.wav>` возвращает текст
(sherpa-onnx + GigaAM-v3, CPU/ONNX, офлайн); точность и скорость замерены на автономном round-trip.

## Шаги

- [x] **sherpa-onnx под Node:** `npm i -D sherpa-onnx-node` — prebuilt win-x64 встал без сборки.
- [x] **Модель GigaAM-v3 CTC int8** (224 МБ) → `F:\KLAS\voice\models\gigaam-v3-ctc\` (HF
      `csukuangfj/sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16`, LICENSE MIT проверён;
      bootstrap — curl, команды в истории; фичи GigaAM: 16 кГц / featureDim 64).
- [x] **Харнесс** `tools/voice-hear.mjs <wav>` — текст + тайминги. Замер на эталонном wav (11.3 с
      Пушкина): распознавание 0.36 с, **RTF 0.032**, загрузка модели 0.92 с.
- [x] **Round-trip** `tools/voice-roundtrip.mjs` — Г1-синтез → Г2-распознавание, 10 фраз (числа,
      техтермины, вопрос): **97% слов (59/61)**; оба «промаха» — нестандартные написания в самих
      фразах («квэн»→«квен», «закоммить»→«закомить»), не дефекты распознавания.
- [→Г3] **Запись микрофона** перенесена в Г3 (push-to-talk пишет wav целиком — стриминговый STT
      не нужен до realtime-задач Г5+; не плодим сложность раньше времени).

## Проверка (критерий готовности)

✅ Round-trip 97% ≥ 90%; распознавание в 30 раз быстрее реального времени на CPU.

## Риски

- Prebuilt sherpa-onnx-node под Windows может отставать от версии ядра — тогда сайдкар-exe
  (официальные релизы sherpa-onnx) + вызов из Node.
- GigaAM-v3 лицензия весов — MIT (проверено в research 09), но перепроверить файл лицензии при
  скачивании (правило живости/чистоты OSS).

## Ссылки

[researches/09 §STT](../researches/09_oss_constructor_map.md) · следующая фаза:
[Г3 «Скелет разговора»](13_voice_g3_conversation_skeleton.md)
