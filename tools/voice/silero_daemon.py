# tools/voice/silero_daemon.py — РЕЗИДЕНТНЫЙ сайдкар русского TTS Silero (plans/13, researches/12).
#
# Зачем он есть. Разовый сайдкар silero_say.py грузит модель заново на КАЖДЫЙ синтез — замер
# 2026-07-28: 2.2 с загрузки против 1.5 с самой работы. При нарезке ответа на предложения эта цена
# умножалась бы на число предложений и убивала весь смысл стриминга. Резидент грузит модель ОДИН раз
# и дальше синтезирует по строке за запрос (researches/12 §5, приём «модель держать загруженной»).
#
# Протокол — построчный JSON (stdin → stdout), одна строка = один запрос/ответ:
#   ← {"text": "Привет.", "out": "F:\\...\\a.wav", "voice": "eugene"}
#   → {"ok": true, "out": "...", "audio_sec": 1.2, "t_synth_sec": 0.4, "rtf": 0.33}
#   → {"ok": false, "reason": "no-cyrillic"}     ← нечего произносить (bugs/06), НЕ поломка
#   → {"ok": false, "error": "..."}              ← настоящая ошибка синтеза
# После загрузки модели печатает {"stage": "ready", ...}; выход — EOF на stdin или строка "quit".
#
# Тяжёлую логику (поиск/скачивание весов, параметры) переиспользуем из silero_say.py — один источник
# правды на оба режима (DRY): менять модель или частоту надо в одном месте.

import json
import re
import sys
import time
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from silero_say import DEFAULT_VOICE, SAMPLE_RATE, ensure_model  # noqa: E402

# Тот же охранник, что в voice-say.mjs (bugs/06): препроцессор Silero v5 ru требует хотя бы одну
# русскую букву, иначе кидает ValueError. Здесь он ОБЯЗАН быть тоже: резидент принимает текст напрямую,
# минуя Node-обёртку, а при нарезке по предложениям кусок вида «56.» вполне реален.
HAS_CYRILLIC = re.compile(r"[а-яёА-ЯЁ]")


def out_line(obj):
    print(json.dumps(obj, ensure_ascii=False), file=sys.stdout, flush=True)


def log(obj):
    print(json.dumps(obj, ensure_ascii=False), file=sys.stderr, flush=True)


def write_wav(path: Path, audio, torch) -> None:
    """Сохранить тензор Silero в 16-битный моно-WAV стандартной библиотекой (без зависимостей)."""
    pcm = (audio * 32767).clamp(-32768, 32767).to(torch.int16).numpy().tobytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)


def main() -> None:
    t0 = time.perf_counter()
    import torch

    torch.set_num_threads(4)  # как в разовом сайдкаре: хватает для realtime, систему не душим
    model_file = ensure_model()
    importer = torch.package.PackageImporter(model_file)
    model = importer.load_pickle("tts_models", "model")
    model.to(torch.device("cpu"))
    log({"stage": "ready", "model": model_file.stem, "t_model_load_sec": round(time.perf_counter() - t0, 2)})
    out_line({"stage": "ready", "model": model_file.stem})

    for line in sys.stdin:
        line = line.strip()
        if not line or line == "quit":
            break
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            out_line({"ok": False, "error": f"плохой JSON запроса: {e}"})
            continue

        text = (req.get("text") or "").strip()
        out_path = Path(req.get("out") or "")
        voice = req.get("voice") or DEFAULT_VOICE
        if not text or not out_path.name:
            out_line({"ok": False, "error": "нужны поля text и out"})
            continue
        if not HAS_CYRILLIC.search(text):
            out_line({"ok": False, "reason": "no-cyrillic", "text": text})
            continue

        try:
            t_start = time.perf_counter()
            audio = model.apply_tts(text=text, speaker=voice, sample_rate=SAMPLE_RATE)
            write_wav(out_path, audio, torch)
            synth = time.perf_counter() - t_start
            dur = len(audio) / SAMPLE_RATE
            out_line({
                "ok": True,
                "out": str(out_path),
                "voice": voice,
                "audio_sec": round(dur, 2),
                "t_synth_sec": round(synth, 2),
                "rtf": round(synth / dur, 3) if dur else None,
            })
        except Exception as e:  # noqa: BLE001 — резидент обязан пережить плохой кусок и ждать следующий
            out_line({"ok": False, "error": str(e), "text": text})


if __name__ == "__main__":
    main()
