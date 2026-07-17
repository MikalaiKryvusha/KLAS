# tools/voice/silero_say.py — сайдкар русского TTS Silero (фаза Г1, plans/11).
# Синтез текста в wav локально на CPU (офлайн). Вызывается Node-обёрткой tools/voice-say.mjs;
# можно и напрямую: F:\KLAS\voice\venv\Scripts\python.exe tools/voice/silero_say.py "текст" out.wav
#
# Модель: Silero TTS ru (v5, фолбэк v4) — один .pt-файл в F:\KLAS\voice\models\ (вне git),
# при первом запуске скачивается с models.silero.ai (~50–150 МБ). Голоса: aidar/baykal/eugene и др.
# Тайминги печатаются в stderr JSON-строкой — их читает обёртка.

import json
import sys
import time
import urllib.request
from pathlib import Path

MODELS_DIR = Path(r"F:\KLAS\voice\models")          # веса вне git (карта: инфраструктура voice\)
SAMPLE_RATE = 48000                                  # максимум качества Silero (8/24/48 кГц)
DEFAULT_VOICE = "aidar"                              # мужской, ближе к строю Jarvis; сменит владелец
# Порядок попыток: v5 (цель плана) → v4 (проверенный фолбэк, тот же API)
MODEL_URLS = [
    ("v5_ru", "https://models.silero.ai/models/tts/ru/v5_ru.pt"),
    ("v4_ru", "https://models.silero.ai/models/tts/ru/v4_ru.pt"),
]


def log(obj):
    print(json.dumps(obj, ensure_ascii=False), file=sys.stderr, flush=True)


def ensure_model() -> Path:
    """Вернуть путь к локальному .pt, скачав первый доступный (v5 → v4)."""
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    for name, url in MODEL_URLS:
        local = MODELS_DIR / f"{name}.pt"
        if local.exists():
            return local
    for name, url in MODEL_URLS:
        local = MODELS_DIR / f"{name}.pt"
        try:
            log({"stage": "download", "model": name, "url": url})
            urllib.request.urlretrieve(url, local)
            return local
        except Exception as e:  # noqa: BLE001 — пробуем следующий вариант
            log({"stage": "download_failed", "model": name, "error": str(e)})
            if local.exists():
                local.unlink()
    raise SystemExit("Не удалось получить модель Silero (v5/v4)")


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit('Использование: silero_say.py "текст" out.wav [голос]')
    text, out_path = sys.argv[1], Path(sys.argv[2])
    voice = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_VOICE

    t0 = time.perf_counter()
    import torch  # импорт здесь — чтобы ошибки окружения были видны после лога download

    torch.set_num_threads(4)  # 4 потока CPU достаточно для realtime-синтеза, не душим систему
    model_file = ensure_model()
    t_dl = time.perf_counter()

    # Официальная загрузка Silero: .pt — это torch.package с классом модели внутри
    importer = torch.package.PackageImporter(model_file)
    model = importer.load_pickle("tts_models", "model")
    model.to(torch.device("cpu"))
    t_load = time.perf_counter()

    audio = model.apply_tts(text=text, speaker=voice, sample_rate=SAMPLE_RATE)
    t_tts = time.perf_counter()

    # WAV 16-бит моно — пишем стандартной библиотекой (без лишних зависимостей)
    import wave

    pcm = (audio * 32767).clamp(-32768, 32767).to(torch.int16).numpy().tobytes()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(out_path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)

    dur = len(audio) / SAMPLE_RATE
    log({
        "stage": "done",
        "model": model_file.stem,
        "voice": voice,
        "audio_sec": round(dur, 2),
        "t_model_download_sec": round(t_dl - t0, 2),
        "t_model_load_sec": round(t_load - t_dl, 2),
        "t_synth_sec": round(t_tts - t_load, 2),
        "rtf": round((t_tts - t_load) / dur, 3) if dur else None,  # <1 = быстрее реального времени
        "out": str(out_path),
    })


if __name__ == "__main__":
    main()
