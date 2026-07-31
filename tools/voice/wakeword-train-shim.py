# tools/voice/wakeword-train-shim.py — запуск обучателя openWakeWord с ПРОКЛАДКОЙ совместимости.
#
# Зачем существует. Обучатель тянет цепочку `openwakeword.train` → `openwakeword.data` → `acoustics`,
# а пакет `acoustics` 0.2.6 при импорте подтягивает свой модуль `directivity`, который зовёт
# `scipy.special.sph_harm`. В scipy 1.18 этой функции БОЛЬШЕ НЕТ — её переименовали в `sph_harm_y`
# с другим порядком аргументов. Импорт падает:
#     ImportError: cannot import name 'sph_harm' from 'scipy.special'
#
# Это ровно тот класс, что EXP-0038 (апстрим написан под старое умолчание библиотеки, библиотека
# уехала вперёд). Лечение по тому же образцу: **прокладка поверх вызова, апстрим НЕ форкаем.**
# Форк пришлось бы вести вечно; прокладка живёт до тех пор, пока `acoustics` не починят, и её
# исчезновение мы заметим — она сама скажет, что стала не нужна.
#
# ⚠️ Почему прокладка ЧЕСТНАЯ, а не заглушка. `acoustics` нужен в конвейере РОВНО В ОДНОМ месте —
# `data.py:434`, генерация цветного шума (`acoustics.generator.noise`). Сферические гармоники нам не
# понадобятся никогда. Соблазн — подсунуть пустышку, чтобы импорт прошёл. Так делать нельзя: молчаливо
# неверная функция хуже отсутствующей (`PHILOSOPHY.md` → три двери). Поэтому старое имя отображается
# в новое ПРАВИЛЬНО, с учётом смены порядка аргументов и соглашения об углах:
#     старое: sph_harm(m, n, theta, phi)   theta — азимут [0, 2π],  phi — полярный [0, π]
#     новое:  sph_harm_y(n, m, theta, phi) theta — полярный,        phi — азимут
#   ⇒ sph_harm(m, n, theta, phi) == sph_harm_y(n, m, phi, theta)
#
# Запуск (обычно через tools/voice/wakeword-train.mjs, но работает и напрямую):
#   python tools/voice/wakeword-train-shim.py --training_config <путь> --augment_clips
#
# [NOT-TESTED] — родился 2026-07-31.

import runpy
import sys

import scipy.special

if not hasattr(scipy.special, "sph_harm"):
    if not hasattr(scipy.special, "sph_harm_y"):
        raise RuntimeError(
            "В scipy нет ни sph_harm, ни sph_harm_y — прокладка устарела, разберись, "
            "что изменилось, а не расширяй её вслепую."
        )

    def sph_harm(m, n, theta, phi):
        """Совместимость со старым `scipy.special.sph_harm` (удалён в scipy ≥1.17).

        Порядок аргументов и соглашение об углах в новом API ДРУГИЕ — см. шапку файла.
        """
        return scipy.special.sph_harm_y(n, m, phi, theta)

    scipy.special.sph_harm = sph_harm
    print("[прокладка] scipy.special.sph_harm восстановлена поверх sph_harm_y "
          "(нужна пакету acoustics; см. шапку wakeword-train-shim.py)", flush=True)
else:
    print("[прокладка] scipy.special.sph_harm на месте — прокладка БОЛЬШЕ НЕ НУЖНА, "
          "можно удалить этот файл и звать openwakeword.train напрямую.", flush=True)

# --- ПРОКЛАДКА 2: torchaudio.load через soundfile -------------------------------------------------
#
# В torchaudio 2.13 старые бэкенды чтения звука сняты, и `torchaudio.load` уходит в `torchcodec`,
# а тот требует FFmpeg в сборке **full-shared** (с DLL). У нас на машине ffmpeg статический
# (gyan.dev full_build), поэтому torchcodec падает так:
#     RuntimeError: Could not load libtorchcodec ... libtorchcodec_core8.dll
#
# ⚠️ ЭТИ ГРАБЛИ В ПРОЕКТЕ УЖЕ ОПЛАЧЕНЫ: ровно то же случилось с CosyVoice, и лечение записано в
# `plans/18` — «load_wav подменён на soundfile: в torchaudio 2.13 старые бэкенды сняты, штатный
# вызов уходит в отсутствующий torchcodec». Повторяем известное лечение вместо второго ffmpeg:
# лишний движок ради одной функции — против правила «минимум сущностей» (`GOAL.md`).
#
# Затрагивает и `speechbrain.dataio.read_audio`, и `openwakeword.data` — оба зовут `torchaudio.load`.
import numpy as np                     # noqa: E402
import soundfile as sf                 # noqa: E402
import torch                           # noqa: E402
import torchaudio                      # noqa: E402


def _load_via_soundfile(uri, frame_offset=0, num_frames=-1, normalize=True,
                        channels_first=True, **_kwargs):
    """Замена `torchaudio.load` поверх soundfile.

    Контракт torchaudio: вернуть (waveform, sample_rate), где waveform по умолчанию
    [каналы, отсчёты] (channels_first=True) и float32 в диапазоне [-1, 1] (normalize=True).
    soundfile отдаёт [отсчёты, каналы] — отсюда транспонирование.
    `frame_offset`/`num_frames` поддержаны, потому что speechbrain читает файлы кусками.
    """
    data, sr = sf.read(
        str(uri), dtype="float32", always_2d=True,
        start=int(frame_offset), frames=int(num_frames),
    )
    wav = torch.from_numpy(np.ascontiguousarray(data.T if channels_first else data))
    return wav, sr


_ORIG_TORCHAUDIO_LOAD = torchaudio.load
torchaudio.load = _load_via_soundfile


class _AudioInfo:
    """То, что раньше возвращал `torchaudio.info`. Поля названы как у него: потребители читают
    `.num_frames` и `.sample_rate` (`torch_audiomentations/utils/io.py:100-101`)."""

    __slots__ = ("num_frames", "sample_rate", "num_channels", "bits_per_sample", "encoding")

    def __init__(self, num_frames, sample_rate, num_channels, bits_per_sample, encoding):
        self.num_frames = num_frames
        self.sample_rate = sample_rate
        self.num_channels = num_channels
        self.bits_per_sample = bits_per_sample
        self.encoding = encoding

    def __repr__(self):
        return (f"AudioMetaData(num_frames={self.num_frames}, sample_rate={self.sample_rate}, "
                f"num_channels={self.num_channels})")


def _info_via_soundfile(uri, *_a, **_kw):
    """Замена `torchaudio.info` (снята в torchaudio 2.13 вместе со старыми бэкендами).

    Зовётся из пяти мест: `openwakeword/data.py` (220, 253, 271),
    `speechbrain/.../audio_io.py:103`, `torch_audiomentations/utils/io.py:92`.
    """
    i = sf.info(str(uri))
    bits = {"PCM_16": 16, "PCM_24": 24, "PCM_32": 32, "PCM_U8": 8, "FLOAT": 32, "DOUBLE": 64}
    return _AudioInfo(
        num_frames=i.frames, sample_rate=i.samplerate, num_channels=i.channels,
        bits_per_sample=bits.get(i.subtype, 0), encoding=i.subtype,
    )


torchaudio.info = _info_via_soundfile

# ⚠️ НАМЕРЕННО НЕ подставляем `torchaudio.io`, `list_audio_backends`, `set_audio_backend` — их тоже
# нет, но на нашем пути они не нужны: `torchaudio.io` зовут кодек-аугментация и потоковое
# распознавание речи (мы не делаем ни того, ни другого), а два остальных speechbrain уже обходит сам
# (`torch_audio_backend.py:61` прямо пишет, что их убрали в 2.9+). Подставлять всё подряд «на всякий
# случай» — значит глушить будущие настоящие отказы. Понадобятся — упадут громко, и это правильно.

# Прокладка проверяется НА МЕСТЕ, а не на веру: синтезируем синус с известной амплитудой и частотой,
# пишем, читаем обратно и сверяем ЧИСЛАМИ. Молча неверная загрузка звука испортила бы весь корпус
# аугментации, и заметили бы это только по плохой модели через час (урок EXP-0046).
def _selftest_torchaudio_shim() -> None:
    import tempfile
    sr, freq, amp, n = 16000, 440.0, 0.5, 1600
    t = np.arange(n, dtype=np.float32) / sr
    sig = (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    with tempfile.TemporaryDirectory() as d:
        p = f"{d}/probe.wav"
        sf.write(p, sig, sr)
        wav, got_sr = torchaudio.load(p)
        assert got_sr == sr, f"частота дискретизации {got_sr} вместо {sr}"
        assert wav.shape == (1, n), f"форма {tuple(wav.shape)} вместо (1, {n})"
        assert wav.dtype == torch.float32, f"тип {wav.dtype} вместо float32"
        peak = float(wav.abs().max())
        assert abs(peak - amp) < 0.01, f"пиковая амплитуда {peak:.4f} вместо {amp}"
        err = float(torch.from_numpy(sig).sub(wav[0]).abs().max())
        assert err < 1e-4, f"расхождение с исходным сигналом {err}"

        # info обязана согласоваться с load: число отсчётов должно СОВПАСТЬ с реально прочитанным.
        # Рассогласование этих двух чисел — самый коварный исход: аугментация нарезала бы окна
        # по неверной длине и молча портила клипы.
        meta = torchaudio.info(p)
        assert meta.num_frames == n, f"info.num_frames={meta.num_frames} вместо {n}"
        assert meta.sample_rate == sr, f"info.sample_rate={meta.sample_rate} вместо {sr}"
        assert meta.num_frames == wav.shape[1], "info и load разошлись в числе отсчётов"
    print(f"[прокладка] torchaudio.load/info → soundfile: самопроверка пройдена "
          f"(пик {peak:.3f} при заданных {amp}, расхождение {err:.2e}, "
          f"info и load согласованы на {n} отсчётах)", flush=True)


_selftest_torchaudio_shim()

# Делегируем настоящему обучателю. sys.argv уже содержит наши аргументы: runpy отдаст их модулю
# как есть, а `run_name='__main__'` заставит его выполнить свой блок разбора аргументов.
sys.argv[0] = "openwakeword.train"
runpy.run_module("openwakeword.train", run_name="__main__")
