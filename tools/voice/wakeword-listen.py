# tools/voice/wakeword-listen.py — РЕЗИДЕНТНЫЙ СЛУШАТЕЛЬ: имя открывает разговор (план 19, шаг 5).
#
# Что делает. Держит ОДИН непрерывный поток с микрофона, кормит им обе модели активатора и, услышав
# имя, сам записывает следующую за ним фразу до конца речи. Наружу отдаёт события строками JSON —
# дирижёр `tools/voice-wake.mjs` на них и живёт.
#
# ⛔ Почему захват фразы ЗДЕСЬ, а не в Node. Причина физическая, а не вкусовая: dshow-устройство
# эксклюзивно — пока микрофон держит ffmpeg детектора, второй ffmpeg на него не откроется. Значит
# «слушать имя» и «записать вопрос» обязаны читать ОДИН И ТОТ ЖЕ поток. Побочная выгода крупная:
# запись начинается в тот же миг, когда прозвучало имя, — не нужно тратить 0.5–1 с на подъём второго
# ffmpeg и не срезается начало фразы.
#
# Протокол (stdout, по строке JSON, utf-8):
#   {"stage":"ready","detectors":["jarvis","joy"],"source":"mic"}
#   {"event":"wake","detector":"jarvis","score":0.93,"t":12.3}      ← прозвучало имя
#   {"event":"utterance","detector":"jarvis","wav":"…","sec":2.4,"reason":"silence"}
#   {"event":"empty","detector":"jarvis","reason":"no-speech"}      ← сказали только имя
#   {"stage":"eof"} · {"stage":"error","…"}
# Команды (stdin, по строке JSON):
#   {"cmd":"listen","on":false}   ← заглушить детектор (режим «не перебивать», см. voice-wake.mjs)
#   {"cmd":"quit"}
# Закрытый родителем stdin = quit: осиротевший ffmpeg держал бы микрофон навсегда.
#
# Запуск:
#   F:\KLAS\voice\venv-wakeword\Scripts\python.exe tools/voice/wakeword-listen.py
#   … --wav фикстура.wav      ← прогон БЕЗ микрофона и БЕЗ человека (тем же кодом, что боевой путь)
#   … --selftest              ← самопроверка конечного автомата конца фразы, 6 случаев
#
# [TESTED: 2026-08-01 · самопроверка 6/6 · сквозной прогон из файла: имя услышано, вопрос записан]

import argparse
import collections
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
import wave

import numpy as np

for _s in (sys.stdout, sys.stderr):
    _s.reconfigure(encoding="utf-8", errors="replace")

TRAINED = r"F:\KLAS\voice\wakeword\training"
OUT_DIR = r"F:\KLAS\voice\out"
# Помощник захвата с подавлением собственного эха (`bugs/25`, `plans/20`). Собирается из исходника
# рядом с ним (build.ps1) и в git не хранится.
AEC_EXE = r"F:\KLAS\tools\voice\aec-capture\aec-capture.exe"
SR = 16000
FRAME = 1280                    # 80 мс — родной шаг openWakeWord
MIC_DEFAULT = "Микрофон (NVIDIA Broadcast)"   # тот же дефолт, что у voice-talk.mjs и wakeword-live.py
# ⚠️ Микрофон по имени — хрупкая привязка. Владелец выключил NVIDIA Broadcast при разборе `bugs/25`,
# и устройство с этим именем ИСЧЕЗЛО из системы: слушатель стал падать на пустом потоке, а причина
# выглядела как «микрофон молчит». Поэтому имя — это ПРЕДПОЧТЕНИЕ, а не константа: берём первое
# существующее из списка, и только если ни одного нет — сообщаем внятно, перечислив, что доступно.
MIC_PREFERRED = ["Микрофон (NVIDIA Broadcast)", "Микрофон (BY-V20)"]

# ⭐ ПОРОГ РЕЧИ ВЫСТАВЛЕН ПО ЗАМЕРУ, А НЕ НА ГЛАЗ (2026-08-01, боевой микрофон владельца):
#   тишина комнаты через шумодав NVIDIA Broadcast — средний модуль отсчёта 0.1 (99 кадров подряд);
#   пик живой речи владельца в прогоне 90 с — 1272 (`voice/out/wakeword-live-last.txt`).
# Отсюда 40: в четыреста раз выше тишины и в тридцать раз ниже пика речи — попасть в зазор трудно.
# Порог всё равно берётся АДАПТИВНО (шум × множитель), а это лишь нижняя граница: на микрофоне без
# шумодава пол будет не 0.1, а десятки, и константа одна на всех врала бы.
MIN_LEVEL = 40.0
PREROLL_FRAMES = 2              # 160 мс до срабатывания — страховка от срезанного первого слога
NOISE_FRAMES = 60               # окно оценки шума комнаты (≈5 с) перед фразой
DEBOUNCE_SEC = 1.5              # одно слово даёт несколько кадров выше порога — считаем за одно


def out_line(obj):
    print(json.dumps(obj, ensure_ascii=False), file=sys.stdout, flush=True)


class Endpointer:
    """Конечный автомат «где кончилась фраза»: по среднему модулю отсчётов кадра (80 мс).

    Почему не VAD-модель. `silero_vad.onnx` в проекте лежит и однажды понадобится (researches/14:
    следующий слой — VAD + endpointing), но здесь решается задача попроще: сказать, ЗАМОЛЧАЛ ли
    человек, на микрофоне с шумодавом, где тишина = 0.1, а речь = сотни. Лишняя модель в тракте —
    лишняя сущность (PHILOSOPHY: KISS + Оккам). Автомат отделён от захвата и проверяется числами
    в `--selftest`, поэтому замена на VAD будет заменой ОДНОГО класса, а не переписыванием тракта.

    Возвращает из feed(): None (ничего не решено) · "speech" (речь началась) ·
    "done" (речь кончилась) · "empty" (после имени так и не заговорили) · "max" (уперлись в предел).
    """

    def __init__(self, noise=0.0, mult=4.0, min_level=MIN_LEVEL,
                 wait_sec=2.0, hang_sec=0.9, max_sec=15.0):
        self.on = max(noise * mult, min_level)
        # Гистерезис обязателен: без него любой провал громкости ВНУТРИ слова (глухой согласный,
        # вдох между словами) читался бы как конец фразы и рубил человека на полуслове.
        self.off = self.on * 0.6
        self.wait = max(1, round(wait_sec * SR / FRAME))
        self.hang = max(1, round(hang_sec * SR / FRAME))
        self.limit = max(1, round(max_sec * SR / FRAME))
        self.frames = 0
        self.silence = 0
        self.talking = False

    def feed(self, level):
        self.frames += 1
        if not self.talking:
            if level >= self.on:
                self.talking = True
                self.silence = 0
                return "speech"
            return "empty" if self.frames >= self.wait else None
        if level < self.off:
            self.silence += 1
            if self.silence >= self.hang:
                return "done"
        else:
            self.silence = 0          # заговорил снова — отсчёт тишины начинается заново
        return "max" if self.frames >= self.limit else None


def selftest() -> int:
    """Проверка автомата ЧИСЛАМИ. Каждый случай отвечает на свой вопрос, и случай 4 нарочно ловит
    самую вероятную поломку — порог, вбитый константой вместо адаптации к шуму комнаты."""
    def run(levels, **kw):
        ep = Endpointer(**kw)
        verdicts = []
        for lv in levels:
            v = ep.feed(lv)
            if v:
                verdicts.append((ep.frames, v))
                if v in ("done", "empty", "max"):
                    break
        return verdicts

    cases = []

    # 1. Обычная фраза: тишина → речь → тишина. Конец объявляется через hang (11 кадров ≈ 0.9 с).
    #    Кадры считаны поимённо: 3 тишины + 20 речи + 11 тишины = 34, «речь» на 4-м.
    v = run([5] * 3 + [500] * 20 + [5] * 15, noise=0.1)
    cases.append(("обычная фраза", v[:1] == [(4, "speech")] and v[-1] == (3 + 20 + 11, "done")))

    # 2. Сказали только имя и молчат — это НЕ пустой вопрос к ядру, это «ничего не спросили».
    v = run([2] * 40, noise=0.1)
    cases.append(("только имя → empty", v == [(25, "empty")]))

    # 3. Речь без конца упирается в предел, а не пишет бесконечный файл.
    v = run([600] * 100, noise=0.1, max_sec=2.0)
    cases.append(("предел длины", v[-1] == (25, "max")))

    # 4. ⛔ ШУМНАЯ КОМНАТА (микрофон без шумодава, пол 200). Порог обязан подняться до 800:
    #    уровень 500 здесь — это шум, и принять его за речь значит записывать пустоту вечно.
    ep = Endpointer(noise=200.0)
    quiet_ok = all(ep.feed(500) is None for _ in range(10))
    cases.append(("шумная комната: 500 — не речь", quiet_ok and ep.on == 800.0))

    # 5. Провал громкости внутри фразы (глухой согласный) фразу НЕ обрывает: 30 ниже порога взятия
    #    (40), но выше порога отпускания (24) — ровно ради этого зазора гистерезис и стоит.
    v = run([500] * 5 + [30] * 8 + [500] * 5 + [1] * 15, noise=0.1)
    cases.append(("провал внутри фразы", v[-1] == (5 + 8 + 5 + 11, "done")))

    # 6. Порог берётся от шума, когда шум ВЫШЕ нижней границы, и от границы, когда ниже.
    cases.append(("порог = max(шум×4, 40)",
                  Endpointer(noise=0.1).on == MIN_LEVEL and Endpointer(noise=50).on == 200.0))

    ok = 0
    for name, good in cases:
        print(f"  {'✅' if good else '❌'}  {name}")
        ok += bool(good)
    print(f"\n  {ok}/{len(cases)}")
    return 0 if ok == len(cases) else 1


def frames_from_proc(cmd, errbuf):
    """Непрерывный поток кадрами по 80 мс из дочернего процесса, пишущего 16 кГц моно s16le в stdout.

    Общий читатель для ДВУХ источников — ffmpeg и помощника с подавлением эха: у них один и тот же
    контракт вывода, поэтому смена источника не должна расползаться по коду (bugs/25, plans/20).
    """
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    # stderr читаем ОТДЕЛЬНЫМ потоком: занятый или переименованный микрофон иначе даёт молчание,
    # неотличимое от тишины в комнате, и причина отказа остаётся невидимой (тот же класс, что в
    # voice-talk.mjs — там обвязку ffmpeg уже чинили ревизией 2026-07-31).
    threading.Thread(target=lambda: errbuf.append(p.stderr.read().decode("utf-8", "replace")),
                     daemon=True).start()
    try:
        while True:
            raw = p.stdout.read(FRAME * 2)
            if not raw or len(raw) < FRAME * 2:
                return
            yield np.frombuffer(raw, dtype=np.int16)
    finally:
        try:
            p.terminate()
        except Exception:      # noqa: BLE001
            pass


def dshow_audio_devices():
    """Какие звуковые устройства dshow реально есть в системе (спрашиваем ffmpeg, а не помним)."""
    p = subprocess.run(["ffmpeg", "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
                       capture_output=True)
    txt = p.stderr.decode("utf-8", "replace")
    # ⚠️ Формат вывода ffmpeg МЕНЯЛСЯ, и разбирать надо оба. Свежие сборки печатают тип суффиксом:
    #   [in#0 @ …] "Микрофон (BY-V20)" (audio)
    # старые — заголовками секций «DirectShow audio devices», а под ними просто имена в кавычках.
    # Разбор только по заголовкам давал ПУСТОЙ список на новой сборке, то есть «микрофонов нет» —
    # ошибка, неотличимая от отсутствия устройств (поймано на себе 2026-08-01).
    names, in_audio = [], False
    for line in txt.splitlines():
        m = re.match(r'^.*?"(.+)"\s*\((audio|video)\)\s*$', line)
        if m:
            if m.group(2) == "audio":
                names.append(m.group(1))
            continue
        if "DirectShow audio devices" in line:
            in_audio = True
            continue
        if "DirectShow video devices" in line:
            in_audio = False
            continue
        if in_audio and '"' in line and "Alternative name" not in line:
            names.append(line.split('"')[1])
    return names


def pick_mic(explicit):
    """Имя микрофона: явное — как есть; иначе первое СУЩЕСТВУЮЩЕЕ из предпочтений.

    Привязка к одному имени уже подвела: выключенный NVIDIA Broadcast унёс устройство, и слушатель
    молчал без объяснения (`bugs/25`, разбор 2026-08-01).
    """
    if explicit:
        return explicit
    have = dshow_audio_devices()
    for name in MIC_PREFERRED:
        if name in have:
            return name
    return have[0] if have else MIC_PREFERRED[0]


def frames_from_ffmpeg(device, errbuf):
    """Микрофон как есть. Слышит и собственный голос ассистента из колонок — перебить нельзя."""
    return frames_from_proc(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "dshow",
         "-i", f"audio={device}", "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"], errbuf)


def frames_from_aec(mic, spk, errbuf):
    """Микрофон, из которого ВЫЧТЕНА собственная речь ассистента (`bugs/25`, `plans/20` шаг 3).

    Источник — встроенный в Windows Voice Capture DSP в режиме source (наш помощник
    `tools/voice/aec-capture`). Контракт вывода тот же, что у ffmpeg, поэтому весь остальной код
    слушателя не знает, откуда пришли кадры, — и это главное свойство врезки.
    """
    return frames_from_proc([AEC_EXE, "--mic", str(mic), "--spk", str(spk)], errbuf)


def frames_from_wav(path, realtime=False):
    """Тот же тракт, но из файла: так шаг 5 проверяется БЕЗ человека и БЕЗ микрофона.

    `realtime` выдаёт кадры в темпе настоящей речи. Без него файл пролетает за доли секунды, и всё,
    что зависит от ВРЕМЕНИ (перебивание посреди ответа, глушение на время своей речи), проверить
    нечем: события успевают прийти раньше, чем дирижёр начнёт ход."""
    import soundfile as sf
    d, sr = sf.read(path, dtype="float32")
    if d.ndim > 1:
        d = d.mean(axis=1)
    if sr != SR:
        from scipy.signal import resample_poly
        g = np.gcd(int(sr), SR)
        d = resample_poly(d, SR // g, int(sr) // g)
    x = (np.clip(d, -1, 1) * 32767).astype(np.int16)
    t0 = time.time()
    for i in range(len(x) // FRAME):
        if realtime:
            due = (i + 1) * FRAME / SR - (time.time() - t0)
            if due > 0:
                time.sleep(due)
        yield x[i * FRAME:(i + 1) * FRAME]


def write_wav(path, frames):
    data = np.concatenate(frames) if frames else np.zeros(0, dtype=np.int16)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())
    return len(data) / SR


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default=None,
                    help="имя dshow-микрофона; без него берётся первый существующий из предпочтений")
    # ── Источник с подавлением собственного эха (`bugs/25`, `plans/20` шаг 3) ──
    # ⚠️ Микрофон для AEC берётся СЫРОЙ, до нейросетевого шумодава. Подавитель подстраивает модель
    # ЛИНЕЙНОГО пути «колонки → микрофон»; поставь перед ним нелинейную обработку (шумодав NVIDIA
    # Broadcast, «студийный голос») — и связь опорного сигнала с записанным перестанет быть
    # линейной, а фильтр не сойдётся. Отсюда индексы waveIn, а не имя виртуального устройства.
    # Активатору шумодав всё равно не нужен: замером показано, что шум ему безразличен
    # (`researches/23` §0, 0.92–0.98 даже при +12 дБ).
    ap.add_argument("--aec", action="store_true",
                    help="брать звук через встроенный AEC Windows вместо ffmpeg (перебивание)")
    ap.add_argument("--aec-mic", type=int, default=0, help="индекс waveIn СЫРОГО микрофона")
    ap.add_argument("--aec-spk", type=int, default=0, help="индекс waveOut колонок, куда играет ассистент")
    ap.add_argument("--wav", default=None, help="прогон из файла вместо микрофона")
    ap.add_argument("--realtime", action="store_true",
                    help="выдавать кадры файла в темпе живой речи (нужно для проверок, зависящих от времени)")
    # Список поднимаемых детекторов = ключи персон (`tools/voice/personas.mjs`). Третье имя
    # «Ариэль» добавлено владельцем 2026-08-01 как эксперимент по устойчивости к перебиванию
    # (`plans/20`); Джой оставлена рядом намеренно — сравниваем два имени на одном стенде.
    ap.add_argument("--detectors", default="jarvis,joy,ariel")
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--speaking-tail", type=float, default=0.32,
                    help="сколько секунд ждать реальной тишины после того, как ассистент замолчал "
                         "(bugs/26): больше — надёжнее от эха, меньше — не съедает начало фразы")
    ap.add_argument("--hang", type=float, default=0.9, help="секунд тишины = конец фразы")
    # ⭐ ПЯТЬ СЕКУНД — ТРЕБОВАНИЕ ВЛАДЕЛЬЦА (2026-08-01, живой тест): «напрягает, что коротко меня
    # слушает, быстро появляется (тишина — ничего не распознано). Я просил 5 секунд окна».
    # Прежние 2 с достались от первой сборки, где имя и вопрос произносились одной фразой. В живом
    # разговоре человек зовёт, слышит сигнал и только потом формулирует — двух секунд на это мало.
    ap.add_argument("--wait", type=float, default=5.0, help="секунд ожидания речи после имени")
    ap.add_argument("--max", type=float, default=15.0, help="предел длины одной фразы")
    ap.add_argument("--out-dir", default=OUT_DIR)
    ap.add_argument("--seconds", type=float, default=0.0,
                    help="слушать не дольше N секунд звука (0 = пока не скажут выйти)")
    ap.add_argument("--parent", action="store_true",
                    help="мной управляет родитель по stdin: закрытие канала = его смерть = выход")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()

    if a.selftest:
        return selftest()

    names = [s.strip() for s in a.detectors.split(",") if s.strip()]
    # ⚠️ Отсутствующая модель — НЕ повод не запускаться. Имя может быть в списке персон, но ещё не
    # обучено (так появилась «Ариэль»: персона заведена, модель считается). Прежний код валил весь
    # слушатель, то есть новое имя в списке ломало РАЗГОВОР С УЖЕ РАБОТАЮЩИМИ. Пропуск объявляется
    # вслух: молчаливо выпавший детектор — это «меня не слышат» без объяснения.
    have = [n for n in names if os.path.exists(os.path.join(TRAINED, f"{n}.onnx"))]
    skipped = [n for n in names if n not in have]
    if skipped:
        out_line({"stage": "warn", "reason": "model-not-trained", "detectors": skipped})
    if not have:
        out_line({"stage": "error", "reason": "no-models",
                  "missing": [os.path.join(TRAINED, f"{n}.onnx") for n in names]})
        return 2
    paths = [os.path.join(TRAINED, f"{n}.onnx") for n in have]

    from openwakeword.model import Model
    model = Model(wakeword_models=paths, inference_framework="onnx")

    cmds = queue.Queue()

    def read_stdin():
        for line in sys.stdin:
            cmds.put(line.strip())
        # Конец канала. Для ЗАПУЩЕННОГО РОДИТЕЛЕМ это смерть родителя — уходим, иначе осиротевший
        # ffmpeg держал бы микрофон навсегда. Для запуска руками из терминала stdin закрыт С САМОГО
        # НАЧАЛА, и то же правило убивало прогон на первом же кадре (поймано на себе 2026-08-01),
        # поэтому режим объявляется флагом, а не угадывается.
        if a.parent:
            cmds.put('{"cmd":"quit"}')

    threading.Thread(target=read_stdin, daemon=True).start()

    errbuf = []
    if a.wav:
        source, src_name, src_dev = frames_from_wav(a.wav, a.realtime), "wav", None
    elif a.aec:
        if not os.path.exists(AEC_EXE):
            out_line({"stage": "error", "reason": "no-aec-exe", "path": AEC_EXE,
                      "hint": "powershell -File tools\\voice\\aec-capture\\build.ps1"})
            return 2
        source = frames_from_aec(a.aec_mic, a.aec_spk, errbuf)
        src_name, src_dev = "aec", f"waveIn {a.aec_mic} / waveOut {a.aec_spk}"
    else:
        dev = pick_mic(a.device)
        source, src_name, src_dev = frames_from_ffmpeg(dev, errbuf), "mic", dev
    out_line({"stage": "ready", "detectors": list(model.models.keys()),
              "source": src_name, "device": src_dev})

    listening = True
    speaking = False        # говорит ли сейчас сам ассистент (объявляет дирижёр, `bugs/26`)
    quiet_wait = 0          # сколько кадров ждём реальной тишины после конца своей речи
    # ⚠️ ПОТОЛОК ОЖИДАНИЯ — РАЗМЕН, А НЕ ПРОСТО ЗАЩИТА ОТ ЗАВИСАНИЯ. Ждём тишины после того, как
    # дирижёр объявил «я замолчал», потому что звук в динамике гаснет позже убийства проигрывателя.
    # Но если владелец заговорил СРАЗУ, тишины не будет вовсе — и каждый лишний кадр ожидания
    # съедает начало его фразы. Поймано стендом `wake-speaking-probe.mjs`: при потолке 8 кадров
    # ожидание досиживало до предела (0.64 с) просто потому, что человек уже говорил.
    # ⚠️ Значение 4 (0.32 с) — ОГРАНИЧЕННАЯ ОЦЕНКА, а не замер: настоящая задержка «убили
    # проигрыватель → в комнате тихо» не измерялась, для этого нужен звук в комнате и слово
    # владельца. Пока не измерена — держим коротким, потому что съеденное начало фразы владелец
    # замечает сразу, а лишний хвост эха портит только распознавание.
    QUIET_MAX = max(1, int(round(a.speaking_tail * SR / FRAME)))
    capture = None
    preroll = collections.deque(maxlen=PREROLL_FRAMES)
    noise_win = collections.deque(maxlen=NOISE_FRAMES)
    last_fire = {k: -9.0 for k in model.models}
    seen = 0

    for audio in source:
        seen += 1
        # Время ЗВУКА, а не настенное. В прогоне из файла кадры идут в сотни раз быстрее реального
        # времени, и антидребезг на настенных часах проглотил бы все срабатывания после первого —
        # то есть харнесс мерил бы не то, что бой (тот же класс, что EXP-0047: прибор должен давать
        # одно и то же число на одном звуке).
        t = seen * FRAME / SR
        if a.seconds and t >= a.seconds and capture is None:
            out_line({"stage": "timeup", "seconds": round(t, 1)})
            return 0
        while not cmds.empty():
            raw = cmds.get()
            try:
                c = json.loads(raw)
            except ValueError:
                continue
            if c.get("cmd") == "quit":
                out_line({"stage": "bye"})
                return 0
            if c.get("cmd") == "listen":
                was, listening = listening, bool(c.get("on", True))
                if listening and not was:
                    model.reset()      # буфер держит чужой звук — иначе он «догорит» уже после снятия глушения
                out_line({"stage": "listen", "on": listening})
            # ⛔ «Сейчас говорю сам» (`bugs/26`). Дирижёр объявляет это перед первым звуком ответа и
            # снимает, убив проигрывателя. Пока флаг поднят, захват фразы НЕ КОПИТ КАДРЫ: иначе в
            # вопрос владельца попадает хвост собственной речи из динамика, уши честно его
            # расшифровывают, и в ядро уезжает каша. Детекция при этом продолжает работать —
            # перебивание именем никуда не девается.
            if c.get("cmd") == "speaking":
                speaking = bool(c.get("on", False))

        level = float(np.abs(audio).mean())

        if capture is not None:
            # ── Отложенный старт: не пишем, пока в комнате звучим МЫ (`bugs/26`) ──
            # Захват уже «взведён» (детекция сработала), но кадры копить нельзя: пока говорит
            # динамик, в них лежит наш собственный голос. Ждём двух вещей подряд — объявления
            # дирижёра «я замолчал» И реально тихого кадра, потому что объявление приходит по трубе,
            # а буфер операционной системы доигрывает после убийства проигрывателя.
            if capture.get("pending"):
                if speaking:
                    continue
                quiet_wait += 1
                if level >= capture["ep"].on and quiet_wait < QUIET_MAX:
                    continue                      # ещё звучит наш хвост — ждём
                capture["pending"] = False
                capture["frames"] = []            # предзапись заведомо чужая: выбрасываем
                out_line({"event": "capture-start", "detector": capture["detector"],
                          "waited_frames": quiet_wait})
                quiet_wait = 0

            capture["frames"].append(audio)
            verdict = capture["ep"].feed(level)
            if verdict in ("done", "max", "empty"):
                det = capture["detector"]
                if verdict == "empty":
                    out_line({"event": "empty", "detector": det, "reason": "no-speech"})
                else:
                    wav = os.path.join(a.out_dir, f"wake-{det}-{int(time.time() * 1000)}.wav")
                    sec = write_wav(wav, capture["frames"])
                    out_line({"event": "utterance", "detector": det, "wav": wav,
                              "sec": round(sec, 2), "reason": "silence" if verdict == "done" else "max"})
                capture = None
                model.reset()          # звук вопроса не должен догорать в окне детектора
            continue

        noise_win.append(level)
        preroll.append(audio)
        if not listening:
            continue

        scores = model.predict(audio)
        hits = [(v, k) for k, v in scores.items() if v >= a.threshold and t - last_fire[k] > DEBOUNCE_SEC]
        if not hits:
            continue
        score, det = max(hits)         # два имени в одном кадре — отвечает то, что прозвучало громче
        last_fire[det] = t
        out_line({"event": "wake", "detector": det, "score": round(float(score), 3),
                  "t": round(t, 2), "level": round(level, 1)})
        capture = {
            "detector": det,
            "frames": list(preroll),
            "ep": Endpointer(noise=float(np.median(noise_win)) if noise_win else 0.0,
                             wait_sec=a.wait, hang_sec=a.hang, max_sec=a.max),
            # Перебили посреди нашей же реплики ⇒ захват взведён, но ждёт тишины (`bugs/26`).
            "pending": speaking,
        }
        quiet_wait = 0
        preroll.clear()

    # Поток кончился. Для файла это норма, для микрофона — отказ, и молчать о нём нельзя:
    # мёртвый микрофон неотличим от тишины в комнате (EXP-0027).
    if capture is not None and capture["frames"]:
        det = capture["detector"]
        wav = os.path.join(a.out_dir, f"wake-{det}-{int(time.time() * 1000)}.wav")
        sec = write_wav(wav, capture["frames"])
        out_line({"event": "utterance", "detector": det, "wav": wav,
                  "sec": round(sec, 2), "reason": "eof"})
    if a.wav:
        out_line({"stage": "eof", "frames": seen})
        return 0
    out_line({"stage": "error", "reason": "mic-stream-ended", "frames": seen,
              "stderr": ("".join(errbuf))[:400]})
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
