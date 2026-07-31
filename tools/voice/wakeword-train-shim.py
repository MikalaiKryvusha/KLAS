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

import os
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


# --- ПРОКЛАДКА 3: trim_mmap, пригодный для Windows ------------------------------------------------
#
# `openwakeword/data.py:trim_mmap` отрезает у файла фич хвост пустых строк так: открывает исходник
# отображением в память (`np.load(..., mmap_mode='r')`), копирует нужное в новый файл, затем
# `os.remove(исходник)` и переименовывает. На Linux удалить открытый файл законно — ссылка исчезает,
# данные живут до закрытия. **На Windows это запрещено**, и стадия падает НА САМОМ КОНЦЕ, потратив
# всё время вычисления фич:
#     PermissionError: [WinError 32] файл занят другим процессом: positive_features_train.npy
#
# Лечение — закрыть оба отображения ДО удаления. Апстрим не форкаем: подменяем функцию в его модуле,
# благо `utils.py:563` импортирует её ВНУТРИ тела (то есть в момент вызова), и подмена доедет.
#
# Заодно чиню их латентный ляп: `mmap_path.strip(".npy")` — это `str.strip`, который снимает СИМВОЛЫ
# из набора, а не суффикс. Для `positive_features_train.npy` он съедает и хвостовую «n» слова
# «train», давая `..._trai2.npy`. Их код это переживает (файл потом переименовывается обратно), но
# повторять ошибку в своей замене незачем.
import gc  # noqa: E402

import openwakeword.data as _oww_data  # noqa: E402
from numpy.lib.format import open_memmap  # noqa: E402


def _close_memmaps_for(path) -> int:
    """Закрыть ВСЕ отображения этого файла, где бы они ни жили.

    ⚠️ Без этого прокладка бесполезна, и первая её версия именно поэтому и не сработала.
    Держит файл не `trim_mmap`, а ВЫЗЫВАЮЩИЙ: `utils.py:571` открывает
    `fp = open_memmap(output_file, mode='w+')`, пишет в него фичи и зовёт `trim_mmap(output_file)`
    строкой 601, **не закрыв `fp`**. На Linux это безобидно, на Windows делает удаление невозможным.
    Закрывать чужое отображение здесь безопасно: `trim_mmap` — ПОСЛЕДНЯЯ строка той функции,
    после неё `fp` уже не используется.
    """
    import warnings
    target = os.path.normcase(os.path.abspath(str(path)))
    closed = 0
    # Обход всех живых объектов трогает ленивые атрибуты чужих модулей и вызывает их
    # предупреждения об устаревании (например, torch.distributed.reduce_op). Это шум обхода,
    # а не наша проблема, и он повторился бы на каждом из четырёх файлов фич.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for obj in gc.get_objects():
            try:
                if isinstance(obj, np.memmap) and obj.filename and \
                        os.path.normcase(os.path.abspath(str(obj.filename))) == target:
                    obj._mmap.close()
                    closed += 1
            except (AttributeError, ValueError, ReferenceError, BufferError):
                continue
    return closed


def _trim_mmap_windows_safe(mmap_path):
    """Замена `openwakeword.data.trim_mmap`, работающая на Windows."""
    src = np.load(mmap_path, mmap_mode="r")

    # Ищем последнюю НЕпустую строку — логика апстрима сохранена дословно.
    i = -1
    while np.all(src[i, :, :] == 0):
        i -= 1
    n_new = src.shape[0] + i + 1

    tmp_path = str(mmap_path)[:-4] + "2.npy" if str(mmap_path).endswith(".npy") else str(mmap_path) + "2.npy"
    dst = open_memmap(tmp_path, mode="w+", dtype=np.float32,
                      shape=(n_new, src.shape[1], src.shape[2]))
    for start in range(0, n_new, 1024):
        end = min(start + 1024, n_new)
        dst[start:end] = src[start:end]
    dst.flush()

    # ⚠️ Вот ради чего вся прокладка: отпустить ВСЕ отображения файла до os.remove — и свои,
    # и чужое `fp` вызывающего (см. докстринг `_close_memmaps_for`).
    dst._mmap.close()
    src._mmap.close()
    del dst, src
    gc.collect()
    _close_memmaps_for(mmap_path)
    gc.collect()

    os.remove(mmap_path)
    os.rename(tmp_path, mmap_path)


def _selftest_trim_mmap() -> None:
    """Проверка ЧИСЛАМИ и в НАСТОЯЩИХ условиях отказа.

    ⚠️ Первая версия этой самопроверки была слабой и потому пропустила дефект: она закрывала
    отображение перед вызовом, а в бою вызывающий (`utils.py:571`) держит своё `fp` ОТКРЫТЫМ.
    Проверка, не воспроизводящая настоящее условие отказа, доказывает только сама себя
    (`BUG_FIXING_FRAMEWORK.md` → «подай охраннику ровно тот дефект, ради которого он существует»).
    Поэтому здесь `arr` НАМЕРЕННО остаётся открытым на момент вызова.
    """
    import tempfile
    rows_full, rows_empty, shape = 7, 5, (16, 96)
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "probe.npy")
        arr = open_memmap(p, mode="w+", dtype=np.float32, shape=(rows_full + rows_empty, *shape))
        arr[:rows_full] = np.arange(rows_full * shape[0] * shape[1], dtype=np.float32).reshape(rows_full, *shape) + 1.0
        arr[rows_full:] = 0.0
        expected = np.array(arr[:rows_full])
        arr.flush()

        # ⭐ `arr` НЕ закрывается — воспроизводим ровно то, что делает вызывающий в бою.
        _trim_mmap_windows_safe(p)

        got = np.load(p, mmap_mode="r")
        assert got.shape == (rows_full, *shape), f"форма {got.shape} вместо {(rows_full, *shape)}"
        assert np.array_equal(np.array(got), expected), "данные после обрезки не совпали с исходными"
        got._mmap.close()
        del got
        gc.collect()
    print(f"[прокладка] trim_mmap для Windows: самопроверка пройдена "
          f"({rows_full + rows_empty} строк ужаты до {rows_full}, данные совпали побайтово)", flush=True)


_oww_data.trim_mmap = _trim_mmap_windows_safe
_selftest_trim_mmap()

# Делегируем настоящему обучателю. sys.argv уже содержит наши аргументы: runpy отдаст их модулю
# как есть, а `run_name='__main__'` заставит его выполнить свой блок разбора аргументов.
sys.argv[0] = "openwakeword.train"
runpy.run_module("openwakeword.train", run_name="__main__")
