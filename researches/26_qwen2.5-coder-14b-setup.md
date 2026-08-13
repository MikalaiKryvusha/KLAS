# Research 26 — Qwen2.5-Coder-14B-Instruct: настройка для KLAS на RTX 5070 Ti

> Сформировано 2026-08-04. Модель скачена в `F:\KLAS\LLMs\LLAMACPP_MODELS\Qwen2.5-Coder-14B-Instruct-Q5_K_M.gguf`.
> Связано: `llama-swap/config.yaml`, `llamacpp/bat/`, `researches/03_gguf_quantization.md`.

## Обзор модели

| Параметр | Значение |
|----------|----------|
| Параметры | 14.7B (13.1B non-embedding) |
| Архитектура | Transformer, RoPE, SwiGLU, RMSNorm, GQA (40Q / 8KV) |
| Нативный контекст | 131,072 токенов (поддерживает до 1M через YaRN) |
| Training tokens | 5.5 трлн (код + математика + текст) |
| Код-способности | SOTA для open-source, сопоставима с GPT-4o на 32B |
| Квант | Q5_K_M (~4.5 бита на вес) |

## Выбор кванта

| Квант | Размер файла | VRAM модели | Контекст 128K | Итого VRAM | Качество | Рекомендация |
|-------|-------------|-------------|---------------|------------|----------|--------------|
| Q5_K_M | ~8.5 GB | ~8.5 GB | ~3-4 GB | ~12-13 GB | Отличный | ✅ **ОСНОВНОЙ** |
| Q8_0 | ~14 GB | ~14 GB | ~1-2 GB (32K) | ~15-16 GB | Эталонный | ⚠️ запасной (макс. качество) |
| Q6_K | ~10.5 GB | ~10.5 GB | ~2.5 GB | ~13-14 GB | Очень хороший | ⚠️ альтернатива |
| Q4_K_M | ~7 GB | ~7 GB | ~4 GB | ~11-12 GB | Хороший | ⚠️ если нужно больше контекста |

**Выбор: Q5_K_M как основной баланс.** Оставляет ~3 GB VRAM на контекст и системы.

## Оптимальные параметры llama.cpp

### Для агентов / кода (основной профиль)

```bash
llama-server.exe \
  -m Qwen2.5-Coder-14B-Instruct-Q5_K_M.gguf \
  --port ${PORT} \
  -c 131072 \                    # 128K контекст (нативный максимум)
  -ctk q8_0 -ctv q8_0 \          # KV q8_0 (x2 вместимость, безопасно)
  -ngl 99 \                      # Все слои на GPU
  --flash-attn on \              # Flash Attention (+15-20% скорость)
  -b 2048 -ub 1024 \             # Batch size оптимален
  --jinja \                      # ОБЯЗАТЕЛЕН для tool calling
  -np 1 --slots --cont-batching \ # Continuous batching
  --temperature 0.7 \            # Баланс точности/креативности
  --top-p 0.8 \                  # Top-p сэмплинг
  --top-k 20 \                   # Top-k сэмплинг
  --min-p 0 \                    # Без min-p ограничений
  --chat-template-kwargs "{\"enable_thinking\": false}"  # Чистый ответ
```

### Для чата / размышлений (альтернативный профиль)

```bash
llama-server.exe \
  -m Qwen2.5-Coder-14B-Instruct-Q5_K_M.gguf \
  --port ${PORT} \
  -c 65536 \
  -ctk q8_0 -ctv q8_0 \
  -ngl 99 \
  --flash-attn on \
  -b 2048 -ub 1024 \
  --jinja \
  -np 1 --slots --cont-batching \
  --temperature 0.9 \              # Больше креативности
  --top-p 0.9 \
  --top-k 50 \
  --min-p 0 \
  --chat-template-kwargs "{\"enable_thinking\": false}"
```

### Для максимального контекста (long-context задачи)

```bash
llama-server.exe \
  -m Qwen2.5-Coder-14B-Instruct-Q5_K_M.gguf \
  --port ${PORT} \
  -c 262144 \                      # 256K (YaRN scaling)
  -ctk q8_0 -ctv q8_0 \
  -ngl 99 \
  --flash-attn on \
  -b 2048 -ub 1024 \
  --jinja \
  -np 1 --slots --cont-batching \
  --rope-scaling yarn \
  --rope-scale 4 \
  --yarn-orig-ctx 32768 \
  --temperature 0.7 \
  --top-p 0.8 \
  --top-k 20 \
  --min-p 0
```

## Ожидаемая производительность (RTX 5070 Ti 16 GB)

| Метрика | Значение | Примечание |
|---------|----------|------------|
| VRAM модели | ~8.5 GB | Q5_K_M, полный offload |
| VRAM контекста | ~3-4 GB | 128K при q8_0 KV |
| Итого VRAM | ~12-13 GB | Запас ~3 GB |
| Генерация | ~80-120 t/s | Зависит от билда llama.cpp |
| Prompt processing | ~2000-3000 t/s | С flash-attn |
| Cold start | ~10-20 с | Загрузка модели в VRAM |

## Интеграция с llama-swap

Добавить в `llama-swap/config.yaml` (раздел `models:`):

```yaml
  "qwen2.5-coder-14b":
    cmd: >
      F:\KLAS\llamacpp\llama-server.exe
      -m F:\KLAS\LLMs\LLAMACPP_MODELS\Qwen2.5-Coder-14B-Instruct-Q5_K_M.gguf
      --port ${PORT} -c 131072 -ctk q8_0 -ctv q8_0
      -ngl 99 --flash-attn on -b 2048 -ub 1024 --jinja
      -np 1 --slots --cont-batching
      --temperature 0.7 --top-p 0.8 --top-k 20 --min-p 0
      --chat-template-kwargs "{\"enable_thinking\": false}"
    ttl: 300
```

## Интеграция с VS Code (Zoo Code mode)

В настройках Roo Code / Zoo Code указать:

```json
{
  "api": {
    "baseUrl": "http://127.0.0.1:8080/v1",
    "model": "qwen2.5-coder-14b"
  }
}
```

Или напрямую к llama-server (без llama-swap):

```json
{
  "api": {
    "baseUrl": "http://127.0.0.1:8081/v1",
    "model": ""
  }
}
```

## Сравнение с другими моделями KLAS

| Модель | Параметры | Квант | VRAM | Скорость | Код-качество | Контекст |
|--------|-----------|-------|------|----------|--------------|----------|
| Qwen2.5-Coder-14B | 14.7B | Q5_K_M | ~12 GB | ~80-120 t/s | SOTA код | 128K |
| Qwen3.6-35B-A3B | 35B MoE | IQ3_S | ~13 GB | ~164 t/s | Отличный | 96K |
| Qwythos-9B | 9B | Q5_K_M | ~13 GB | ~67-98 t/s | Хороший | 256K |
| Gemma-4-12B | 12B | Q4_K_XL | ~12 GB | ~63-68 t/s | Хороший | 128K |

## Ссылки

- [Qwen2.5-Coder на HuggingFace](https://huggingface.co/Qwen/Qwen2.5-Coder-14B-Instruct)
- [Официальная документация llama.cpp для Qwen](https://qwen.readthedocs.io/en/v2.5/run_locally/llama.cpp.html)
- [Research 03 — GGUF квантование](./03_gguf_quantization.md)
- [llama-swap GitHub](https://github.com/mostlygeek/llama-swap)
