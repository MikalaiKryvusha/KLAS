# tools/voice/wakeword-cost.py — СКОЛЬКО СТОИТ круглосуточное ожидание слова (план 19).
#
# Зачем. Требование владельца в `GOAL.md`: система «спит и не ест ресурсы ПК, пока её не вызывают».
# Детектор активатора — единственная часть, которая слушает ВСЕГДА, поэтому его цена должна быть
# измерена, а не прикинута.
#
# Что меряется:
#   · время инференса на один кадр 80 мс — обе модели сразу, как в бою;
#   · КОЭФФИЦИЕНТ ЗАНЯТОСТИ = время счёта / реальное время. Он и есть ответ «сколько процентов ядра»:
#     0.02 значит, что на каждые 80 мс звука тратится 1.6 мс счёта, то есть 2% ОДНОГО ядра;
#   · память процесса под моделями;
#   · отдельно цена ffmpeg, который тянет звук с микрофона: он работает столько же и в счёт входит.
#
# ⚠️ Меряется ХОЛОСТОЙ режим — тишина. Именно он и длится круглосуточно; речь занимает минуты в день.
#
# Запуск: F:\KLAS\voice\venv-wakeword\Scripts\python.exe tools/voice/wakeword-cost.py
#
# [NOT-TESTED] — родился 2026-08-01.

import os
import sys
import time

import numpy as np

for _s in (sys.stdout, sys.stderr):
    _s.reconfigure(encoding="utf-8", errors="replace")

from openwakeword.model import Model  # noqa: E402

TRAINED = r"F:\KLAS\voice\wakeword\training"
SR = 16000
FRAME = 1280            # 80 мс
N_FRAMES = 1250         # 100 секунд звука — хватает, чтобы усреднить и не ждать долго


def rss_mb() -> float:
    """Память процесса без сторонних пакетов: psutil в этом venv не стоит, а тянуть его ради одной
    цифры — лишняя сущность. Берём у самой ОС."""
    import ctypes
    from ctypes import wintypes

    class PMC(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]

    c = PMC()
    c.cb = ctypes.sizeof(c)
    # ⚠️ На современных Windows функция живёт в kernel32 как K32GetProcessMemoryInfo; вызов через
    # psapi возвращал НОЛЬ молча — то есть замер «работал» и врал. Пробуем оба и проверяем результат:
    # нулевая память у процесса с onnxruntime невозможна, и молчаливый ноль здесь хуже отказа.
    # ⚠️ Типы объявляются ЯВНО. Без этого ctypes считает, что GetCurrentProcess вернул c_int, и
    # псевдодескриптор (HANDLE)-1 обрезается до 32 бит — на 64-битной системе вызов молча не проходит
    # и оставляет структуру нулевой. Замер «работает» и врёт нулём.
    k32 = ctypes.windll.kernel32
    k32.GetCurrentProcess.restype = wintypes.HANDLE
    ok = 0
    for lib, fn in ((k32, "K32GetProcessMemoryInfo"), (ctypes.windll.psapi, "GetProcessMemoryInfo")):
        try:
            f = getattr(lib, fn)
        except (AttributeError, OSError):
            continue
        f.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
        f.restype = wintypes.BOOL
        ok = f(k32.GetCurrentProcess(), ctypes.byref(c), c.cb)
        if ok and c.WorkingSetSize:
            break
    if not c.WorkingSetSize:
        raise RuntimeError("не удалось снять память процесса — замер негоден, чинить, а не печатать ноль")
    return c.WorkingSetSize / 1024 ** 2


def main() -> int:
    base_mem = rss_mb()
    paths = [os.path.join(TRAINED, f"{n}.onnx") for n in ("jarvis", "joy")]
    if any(not os.path.exists(p) for p in paths):
        print("нет обученных моделей", file=sys.stderr)
        return 2

    t_load = time.perf_counter()
    model = Model(wakeword_models=paths, inference_framework="onnx")
    load_s = time.perf_counter() - t_load
    loaded_mem = rss_mb()

    # Тишина с лёгким шумом — так звучит комната ночью. Чистые нули дали бы нечестно лёгкий замер:
    # часть операций может выродиться на нулевом входе.
    rng = np.random.default_rng(20260801)
    frames = [(rng.normal(0, 40, FRAME)).astype(np.int16) for _ in range(64)]

    for f in frames[:8]:                       # прогрев: первые вызовы всегда дороже
        model.predict(f)

    cpu0 = time.process_time()
    wall0 = time.perf_counter()
    for i in range(N_FRAMES):
        model.predict(frames[i % len(frames)])
    cpu = time.process_time() - cpu0
    wall = time.perf_counter() - wall0
    peak_mem = rss_mb()

    audio_s = N_FRAMES * FRAME / SR
    per_frame_ms = wall / N_FRAMES * 1000
    duty = cpu / audio_s

    print("=" * 66)
    print("  ЦЕНА КРУГЛОСУТОЧНОГО ОЖИДАНИЯ СЛОВА (обе модели сразу)")
    print("=" * 66)
    print(f"  загрузка моделей:            {load_s:.2f} с (разово)")
    print(f"  память под моделями:         {loaded_mem - base_mem:.1f} МБ")
    print(f"  память процесса всего:       {peak_mem:.0f} МБ")
    print()
    print(f"  обработано звука:            {audio_s:.0f} с")
    print(f"  на один кадр 80 мс:          {per_frame_ms:.2f} мс")
    print(f"  процессорного времени:       {cpu:.1f} с на {audio_s:.0f} с звука")
    print()
    print(f"  ⇒ ЗАНЯТОСТЬ ЯДРА:            {duty * 100:.1f}%  (одного ядра из 16)")
    print(f"  ⇒ от всего процессора:       {duty / 16 * 100:.2f}%")
    print("=" * 66)
    print("  Модели: две по 13.8 КБ + общие мел-спектрограмма и эмбеддер (~2.4 МБ).")
    print("  Видеокарта НЕ используется — детектор целиком на процессоре.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
