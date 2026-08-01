# tools/voice/wakeword-live.py — 🏠 ЖИВАЯ ПРОВЕРКА активаторов микрофоном владельца (план 19, шаг 4).
#
# Зачем именно живая. Все прежние замеры — на СИНТЕЗИРОВАННОЙ речи, а синтетика судит МЯГЧЕ
# реальности: в замере 2026-07-29 даже настоящий английский синтез дал готовой модели лишь 0.259 при
# пороге 0.5 (`researches/16` §3.2). Проценты на синтетике — зелёный свет живой проверке, а НЕ
# вердикт (EXP-0016). Здесь наблюдатель по необходимости человек.
#
# Как устроено. ffmpeg тянет с микрофона непрерывный поток 16 кГц моно и отдаёт СЫРОЙ PCM в stdout;
# питон режет его на кадры по 1280 отсчётов (80 мс) и кормит ОБЕ модели сразу. Непрерывность здесь
# принципиальна: модель обучена узнавать слово в момент, когда оно ТОЛЬКО ЧТО закончилось, и в живом
# потоке окно естественно доезжает до этого положения само.
#
# ⚠️ Обе модели в ОДНОМ объекте намеренно: так они видят один и тот же звук в один и тот же момент,
# и «зажглась не та» становится наблюдаемым фактом, а не сравнением двух прогонов.
#
# Запуск:
#   F:\KLAS\voice\venv-wakeword\Scripts\python.exe tools/voice/wakeword-live.py [--seconds 90]
#   [--device "Микрофон (NVIDIA Broadcast)"] [--threshold 0.5]
#
# [NOT-TESTED] — родился 2026-08-01.

import argparse
import os
import subprocess
import sys
import time

import numpy as np

for _s in (sys.stdout, sys.stderr):
    _s.reconfigure(encoding="utf-8", errors="replace")

from openwakeword.model import Model  # noqa: E402

TRAINED = r"F:\KLAS\voice\wakeword\training"
SR = 16000
FRAME = 1280                    # 80 мс — родной шаг библиотеки
MIC_DEFAULT = "Микрофон (NVIDIA Broadcast)"   # тот же дефолт, что у voice-talk.mjs

# Имя модели → как её называть человеку. Ключи совпадают с именами файлов .onnx.
PRETTY = {"jarvis": "ДЖАРВИС", "joy": "ДЖОЙ"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=90)
    ap.add_argument("--device", default=MIC_DEFAULT)
    ap.add_argument("--threshold", type=float, default=0.5)
    # Стенд СМОТРИТ ЧЕЛОВЕК — значит запускать его надо в его терминале, а не фоном (поймано на себе
    # 2026-08-01: прогнал в фоне, вся живая индикация ушла в лог, и владелец остался без обратной
    # связи в интерактивном тесте). Лог нужен ВТОРЫМ экземпляром, чтобы агент прочитал результат
    # потом, не отбирая у человека живую картинку.
    ap.add_argument("--log", default=r"F:\KLAS\voice\out\wakeword-live-last.txt")
    a = ap.parse_args()

    paths = [os.path.join(TRAINED, f"{n}.onnx") for n in ("jarvis", "joy")]
    missing = [p for p in paths if not os.path.exists(p)]
    if missing:
        print("нет обученных моделей: " + ", ".join(missing), file=sys.stderr)
        return 2

    model = Model(wakeword_models=paths, inference_framework="onnx")
    keys = list(model.models.keys())

    print("=" * 68)
    print("  ЖИВАЯ ПРОВЕРКА АКТИВАТОРОВ — говори в микрофон")
    print("=" * 68)
    print(f"  микрофон: {a.device}")
    print(f"  порог срабатывания: {a.threshold}   ·   слушаю {a.seconds} с")
    print()
    print("  Скажи, делая паузы между попытками:")
    print("    «Джарвис»            — должен зажечься ДЖАРВИС и молчать ДЖОЙ")
    print("    «Джой»               — наоборот")
    print("    «Джарвис, включи музыку» — должен сработать сразу после имени")
    print("    что-нибудь обычное   — оба обязаны молчать")
    print("=" * 68)
    print()

    ff = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "dshow",
         "-i", f"audio={a.device}", "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )

    fired = []                  # (секунда, имя, оценка) — для итогового разбора
    last_fire = {k: -9.0 for k in keys}
    t0 = time.time()
    level_at = 0.0
    peak_level = 0
    try:
        while time.time() - t0 < a.seconds:
            raw = ff.stdout.read(FRAME * 2)
            if not raw or len(raw) < FRAME * 2:
                break
            audio = np.frombuffer(raw, dtype=np.int16)
            t = time.time() - t0

            # Индикатор уровня раз в полсекунды: без него человек не знает, СЛЫШИТ ли его стенд
            # вообще, и молчание детектора неотличимо от мёртвого микрофона.
            lvl = int(np.abs(audio).mean())
            peak_level = max(peak_level, lvl)
            if t - level_at >= 0.5:
                level_at = t
                bar = "█" * min(30, lvl // 60)
                print(f"\r  [{t:5.1f}с] микрофон {bar:<30}", end="", flush=True)

            for k, v in model.predict(audio).items():
                # Дребезг: одно слово даёт несколько кадров подряд выше порога. Показываем ОДНО
                # срабатывание на слово, иначе экран заливает и человек не поймёт, что произошло.
                if v >= a.threshold and t - last_fire[k] > 1.5:
                    last_fire[k] = t
                    fired.append((t, k, float(v)))
                    print(f"\r  🔔 [{t:5.1f}с] {PRETTY.get(k, k):<10} сработал — {v:.3f}"
                          f"{' ' * 24}")
    except KeyboardInterrupt:
        print("\n  (остановлено вручную)")
    finally:
        try:
            ff.terminate()
        except Exception:      # noqa: BLE001
            pass

    print("\n" + "=" * 68)
    if peak_level < 30:
        # Тихий микрофон — это ОТКАЗ СТЕНДА, а не отрицательный результат. Молчащий детектор при
        # мёртвом микрофоне неотличим от негодной модели, и путать их нельзя (EXP-0027).
        print(f"  ⚠️ МИКРОФОН ПОЧТИ НЕ СЛЫШНО (пик уровня {peak_level}).")
        print("     Это отказ стенда, а не приговор моделям. Проверь устройство:")
        print("     ffmpeg -list_devices true -f dshow -i dummy")
        return 1

    lines = [f"  Пик уровня микрофона: {peak_level} — звук шёл."]
    if not fired:
        lines.append("  Ни один детектор не сработал.")
    else:
        lines.append(f"  Срабатываний: {len(fired)}")
        lines += [f"    [{t:5.1f}с]  {PRETTY.get(k, k):<10} {v:.3f}" for t, k, v in fired]
    for ln in lines:
        print(ln)
    print("=" * 68)

    try:
        os.makedirs(os.path.dirname(a.log), exist_ok=True)
        with open(a.log, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        print(f"  (итог записан в {a.log})")
    except OSError as e:
        print(f"  (лог не записан: {e})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
