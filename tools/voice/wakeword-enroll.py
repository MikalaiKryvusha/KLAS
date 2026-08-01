# tools/voice/wakeword-enroll.py — ЗАПИСЬ ГОЛОСА ЧЕЛОВЕКА для обучения активатора (план 23).
#
# Зачем. Корпус активатора синтезирует Piper, а зовёт ассистента ЧЕЛОВЕК. Пока эти два голоса
# звучали похоже, всё работало; на имени «Ариэль» они разошлись — синтезатор произносит его
# неустойчиво, отбраковка выбросила 39% клипов НЕРАВНОМЕРНО, доля мужских голосов упала с 70–72%
# до 62%, и владелец на живом микрофоне сказал: «плохо слышит имя» (`plans/20`, EXP-0056).
# Личные записи бьют в корень: модель учится на том, как имя произносит ТОТ, кто будет звать.
#
# Сколько нужно (практика openWakeWord, не догадка): 20–50 личных записей уже заметно улучшают
# распознавание, ~100 дают уверенный результат; личные записи НЕ заменяют синтетический корпус, а
# смешиваются с ним. Целимся в 50 принятых — около трёх минут человеческого времени.
#
# ⛔ ПЯТЬ РЕШЕНИЙ, БЕЗ КОТОРЫХ ЗАТЕЯ ВРЕДНА:
#   1. ТОЛЬКО ИМЯ, отдельной фразой. Обучение выравнивает клип по ПРАВОМУ краю окна
#      (`create_fixed_size_clip`), то есть учит узнавать слово, которое ТОЛЬКО ЧТО закончилось.
#      «Джарвис, включи музыку» имя в начале — такой пример не выучивается (грабли плана 19).
#   2. ОБРЕЗКА ТИШИНЫ — ТРЕБОВАНИЕ ВЛАДЕЛЬЦА И УСЛОВИЕ КАЧЕСТВА. Автомат конца фразы заканчивает
#      запись через 0.7 с тишины; если этот хвост оставить, при выравнивании по правому краю модель
#      будет учиться на «слово, потом пауза» — то есть ровно наоборот нужному. Режем с двух сторон,
#      но с запасом: последний звук в «Джарви-с» тихий, и жадная обрезка съела бы его.
#   3. ПИШЕМ В 48 кГц, храним оригинал. Обучению нужны 16 кГц, но этот же голос понадобится
#      биометрии (`plans/09`) и клонированию (`plans/18`) — переписывать человека второй раз ради
#      качества глупо. Оригиналы идут в `voice/sources/own_voice/`, учебные 16 кГц — в корпус.
#   4. РАЗНООБРАЗИЕ ПО СЦЕНАРИЮ, а не «скажи 50 раз». Пятьдесят одинаковых записей учат узнавать
#      ОДНУ подачу; звать человек будет по-разному.
#   5. ПРОВЕРКА КАЖДОЙ ЗАПИСИ НА МЕСТЕ независимыми ушами: человек не должен узнавать о браке через
#      полчаса обучения.
#
# ⚠️ Инструмент ПИШЕТ МИКРОФОН. Правило владельца 2026-08-01: предупреждать и получать подтверждение.
#
# Запуск: F:\KLAS\voice\venv-wakeword\Scripts\python.exe tools/voice/wakeword-enroll.py --slug jarvis
#         … --count 50   … --device "Микрофон (BY-V20)"   … --dry (проверить тракт, не записывая)
#
# [NOT-TESTED]

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import time
import wave

import numpy as np

for _s in (sys.stdout, sys.stderr):
    _s.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = r"F:\KLAS\voice\wakeword\corpus"
MASTERS = r"F:\KLAS\voice\sources\own_voice"
HEAR = r"F:\KLAS\tools\voice-hear.mjs"

REC_SR = 48000          # чем пишем: студийная частота, оригинал переживёт смену задач
TRAIN_SR = 16000        # чем учим: melspectrogram активатора обучен на 16 кГц
FRAME_MS = 80           # шаг автомата конца фразы — тот же, что в бою
REC_FRAME = REC_SR * FRAME_MS // 1000

# ⚠️ Слово берётся ИЗ КАРТЫ, а не из аргумента: кириллица через argv на Windows — запрещённая
# практика канона (`AGENT_GUIDE` §9). Это слово, которое произносит ЧЕЛОВЕК, и оно может отличаться
# от написания, которым собран синтетический корпус («Ариель» синтезатору против «Ариэль» человеку).
WORD = {"jarvis": "Джарвис", "joy": "Джой", "ariel": "Ариэль"}

# Сценарий: (сколько записей, что сказать человеку, пометка для манифеста).
# Доли подобраны под РЕАЛЬНОЕ употребление, а не под богатство диапазона: основной случай должен
# быть основным и в корпусе. Крика и беззвучного шёпота здесь нет намеренно — на ассистента не
# кричат, а громкий звук ещё и обрезается по амплитуде, то есть модель выучила бы искажение.
SCRIPT = [
    (20, "обычно, как позовёшь в жизни — сидя, лицом к микрофону", "normal"),
    (8,  "вполголоса, спокойно — как вечером", "quiet"),
    (6,  "чуть быстрее, будто на бегу", "fast"),
    (6,  "отвернувшись, говоря в сторону", "away"),
    (6,  "из другого конца комнаты", "far"),
    (4,  "с вопросительной интонацией — «…?»", "question"),
]


def load_listener():
    """Автомат конца фразы и выбор микрофона берутся У БОЕВОГО СЛУШАТЕЛЯ, а не копируются сюда.
    Две копии одного автомата разъезжаются молча, и записи начнут резаться иначе, чем в бою."""
    spec = importlib.util.spec_from_file_location("wl", os.path.join(HERE, "wakeword-listen.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def mic_frames(device, errbuf):
    """Микрофон в 48 кГц кадрами по 80 мс. Свой ffmpeg, а не из слушателя: тот пишет 16 кГц,
    потому что этого хватает активатору, — а нам нужен оригинал, годный и для биометрии."""
    p = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "dshow",
         "-i", f"audio={device}", "-ac", "1", "-ar", str(REC_SR), "-f", "s16le", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    import threading
    threading.Thread(target=lambda: errbuf.append(p.stderr.read().decode("utf-8", "replace")),
                     daemon=True).start()
    try:
        while True:
            raw = p.stdout.read(REC_FRAME * 2)
            if not raw or len(raw) < REC_FRAME * 2:
                return
            yield np.frombuffer(raw, dtype=np.int16)
    finally:
        try:
            p.terminate()
        except Exception:      # noqa: BLE001
            pass


def trim_silence(x, noise_level):
    """Убрать тишину с двух сторон, НЕ съев края слова.

    Порог берётся от пола шума, а не константой: тихая комната и комната с вентилятором дают разный
    пол, и одна цифра на всех врала бы. Запасы по краям НЕ симметричны и не случайны:
      · слева 120 мс — первый согласный («Дж») начинается тише гласной, и жадный левый край
        отрезал бы атаку слова;
      · справа 180 мс — последний звук в «Джарви-с» глухой и тихий; именно его теряют чаще всего.
    Ничего не нашли — возвращаем как есть: пустую обрезку лучше не делать, чем сделать неверную.
    """
    a = np.abs(x.astype(np.float32))
    win = REC_SR // 100                                   # окно 10 мс
    env = np.convolve(a, np.ones(win) / win, mode="same")
    thr = max(noise_level * 3.0, 30.0, float(env.max()) * 0.10)
    loud = np.where(env > thr)[0]
    if len(loud) < win:
        return x, False

    # ⛔ ГРОМКОСТИ МАЛО — НУЖНА ДЛИТЕЛЬНОСТЬ. Живая сессия 2026-08-01: в тихой комнате пол шума
    # около нуля, и «громким» становится любой щелчок, вдох или скрип стула. Резка честно начинала
    # клип с него и оставляла 1.2–2.2 с тишины перед именем (2 клипа из 50). Поднимать порог —
    # тупик: щелчок бывает и громче тихого произнесения, а подняв порог, потеряешь шёпот.
    # Различает их ВРЕМЯ: слово звучит сотни миллисекунд, щелчок — двадцать. Поэтому:
    #   1) соседние громкие куски склеиваем, если разрыв меньше 100 мс (пауза внутри слова, и
    #      тихий «с» на конце «Джарви-с» прилипает к слову, а не теряется);
    #   2) оставляем только куски длиннее 150 мс — короче слов не бывает.
    gap = int(0.100 * REC_SR)
    min_run = int(0.150 * REC_SR)
    runs = []
    start = prev = loud[0]
    for i in loud[1:]:
        if i - prev > gap:
            runs.append((start, prev))
            start = i
        prev = i
    runs.append((start, prev))
    speech = [r for r in runs if r[1] - r[0] >= min_run]
    if not speech:
        return x, False
    loud = np.array([speech[0][0], speech[-1][1]])
    lead = int(0.120 * REC_SR)
    tail = int(0.180 * REC_SR)
    start = max(0, loud[0] - lead)
    end = min(len(x), loud[-1] + tail)
    return x[start:end], True


def to_train_sr(x):
    """48 кГц → 16 кГц честной передискретизацией (не выбрасыванием отсчётов: простое прореживание
    даёт наложение спектра, и в учебный клип уехал бы artefact вместо голоса)."""
    from scipy.signal import resample_poly
    return resample_poly(x.astype(np.float32), TRAIN_SR, REC_SR).astype(np.int16)


def write_wav(path, samples, sr):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(samples.tobytes())
    return len(samples) / sr


def heard_text(wav):
    """Независимый судья: клип записал микрофон, а судят его уши проекта. Модель, проверяющая сама
    себя, доказывает только собственную непротиворечивость."""
    r = subprocess.run(["node", HEAR, wav, "--model", "ru"], capture_output=True)
    return r.stdout.decode("utf-8", "replace").strip().lower()


def levenshtein(a, b):
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def selftest() -> int:
    """Проверка резки и передискретизации БЕЗ микрофона и БЕЗ звука в комнате.

    Резка — самое опасное место инструмента: жадный порог молча съест последний глухой звук у всех
    пятидесяти записей, и человек узнает об этом только после обучения. Поэтому проверяем не «код не
    падает», а поведение на подложенных случаях, где ответ известен заранее.
    """
    ok = 0
    fail = []

    def check(name, cond):
        nonlocal ok
        if cond:
            ok += 1
            print(f"  ✅ {name}")
        else:
            fail.append(name)
            print(f"  ❌ {name}")

    rng = np.random.default_rng(7)

    def clip(word_sec, head_sec, tail_sec, amp=6000, noise=40):
        n_h, n_w, n_t = (int(s * REC_SR) for s in (head_sec, word_sec, tail_sec))
        base = rng.normal(0, noise, n_h + n_w + n_t)
        t = np.arange(n_w) / REC_SR
        base[n_h:n_h + n_w] += amp * np.sin(2 * np.pi * 180 * t) * np.hanning(n_w)
        return base.astype(np.int16), noise

    print("\n=== selftest wakeword-enroll ===")

    x, nz = clip(0.6, 1.0, 0.7)
    cut, ok_trim = trim_silence(x, nz)
    sec = len(cut) / REC_SR
    check(f"тишина срезана с двух сторон: 2.30 с → {sec:.2f} с", ok_trim and 0.75 < sec < 1.15)

    # ⛔ Главный случай: у «Джарви-с» хвост слова тише середины втрое. Жадная резка отрежет «с», и
    # модель будет учиться на обрубке. Проверяем, что тихий хвост ВЫЖИЛ.
    n_h = int(0.8 * REC_SR)
    loud = clip(0.5, 0.8, 0.0)[0]
    t2 = np.arange(int(0.18 * REC_SR)) / REC_SR
    quiet_tail = (700 * np.sin(2 * np.pi * 3000 * t2)).astype(np.int16)
    x2 = np.concatenate([loud, quiet_tail, rng.normal(0, 40, int(0.7 * REC_SR)).astype(np.int16)])
    cut2, _ = trim_silence(x2, 40)
    kept = len(cut2) / REC_SR
    check(f"тихий хвост слова не срезан: сохранено {kept:.2f} с (нужно ≥ 0.85)", kept >= 0.85)

    check("голова слова не обрезана впритык (есть запас ≥ 0.1 с)",
          float(np.abs(cut[:int(0.08 * REC_SR)]).mean()) < 200)

    x3 = rng.normal(0, 40, REC_SR).astype(np.int16)
    check("на чистой тишине честно отказывается, а не режет наугад", trim_silence(x3, 40)[1] is False)

    # ⛔ Случай, который резка ПРОПУСКАЛА до 2026-08-01: тихая комната (пол шума ≈ 0) плюс щелчок
    # за секунду до слова. Порог от пола шума брал щелчок за начало и оставлял секунду тишины.
    n_click = int(0.02 * REC_SR)
    x4 = np.concatenate([
        rng.normal(0, 3, int(0.5 * REC_SR)).astype(np.int16),
        (900 * np.sin(2 * np.pi * 900 * np.arange(n_click) / REC_SR)).astype(np.int16),  # щелчок
        rng.normal(0, 3, int(0.9 * REC_SR)).astype(np.int16),
        clip(0.6, 0.0, 0.2, amp=6000, noise=3)[0],                                        # слово
    ])
    cut4, _ = trim_silence(x4, 3)
    sec4 = len(cut4) / REC_SR
    check(f"щелчок в тишине не принят за начало слова: {len(x4) / REC_SR:.2f} с → {sec4:.2f} с",
          sec4 < 1.2)

    y = to_train_sr(x)
    check(f"передискретизация 48→16 кГц: {len(x)} → {len(y)} отсчётов",
          abs(len(y) - len(x) // 3) <= 2)
    check("после передискретизации сигнал не выродился",
          float(np.abs(y).max()) > 1000)

    check("слово берётся из карты, а не из argv (кириллица через argv запрещена)",
          set(WORD) == {"jarvis", "joy", "ariel"})
    check("сценарий даёт ровно 50 записей", sum(n for n, _, _ in SCRIPT) == 50)

    total = ok + len(fail)
    print(f"\n{ok}/{total} " + ("— стенд исправен" if not fail else f"— ПРОВАЛ: {', '.join(fail)}"))
    return 0 if not fail else 1


def clips(d):
    """Записи голоса — и ТОЛЬКО они. В тех же каталогах живут производные файлы (монтаж прослушки),
    и каждый обход, который берёт «все *.wav», рано или поздно утащит их в обучение: раскладка
    забирает каталог целиком, и склейка всех пятидесяти записей уехала бы туда как один пример
    имени. Один отбор на все обходы — чтобы правило нельзя было забыть в одном из них."""
    return sorted(f for f in os.listdir(d) if f.startswith("own__") and f.endswith(".wav"))


def audit(slug, word_l, train_dir, redo=False) -> int:
    """РАЗБОР записанного: найти клипы, которые прошли проверку, но обучению навредят.

    Проверка на месте отвечает на вопрос «слышно ли имя», и этого мало. Живая сессия 2026-08-01
    показала третий случай: клип в 2.95 с, принятый как «жервис». Одно слово столько не длится —
    значит внутри имя ПЛЮС что-то ещё (в блоке «вполголоса» порог конца фразы срабатывает хуже, а
    в комнате был посторонний звук). Обучение выравнивает клип по правому краю: лишний хвост
    сдвигает имя от края, и пример учит не тому.

    Судим по МЕДИАНЕ самой сессии, а не по константе: у разных людей и имён своя длительность.
    """
    files = clips(train_dir)
    if not files:
        print("записей нет")
        return 1

    rows = []
    for f in files:
        p = os.path.join(train_dir, f)
        with wave.open(p) as w:
            sec = w.getnframes() / w.getframerate()
        rows.append({"file": f, "sec": sec, "path": p})
    med = float(np.median([r["sec"] for r in rows]))
    limit = max(1.8, med * 2.0)

    print(f"\n=== разбор личных записей «{word_l}» ===")
    print(f"клипов: {len(rows)} · медиана {med:.2f} с · порог выброса {limit:.2f} с\n")

    bad = []
    for r in rows:
        why = []
        if r["sec"] > limit:
            why.append(f"длинный ({r['sec']:.2f} с)")
        if r["sec"] < 0.30:
            why.append(f"обрубок ({r['sec']:.2f} с)")
        if why:
            # Уши зовём ТОЛЬКО для подозрительных: прогон всего корпуса стоит минуты, а решает
            # длительность. Услышанный текст нужен, чтобы понять, ЧТО туда попало лишнего.
            heard = heard_text(r["path"])
            extra = len(heard.split()) > 1
            if extra:
                why.append(f"лишние слова: «{heard}»")
            else:
                why.append(f"услышано «{heard}»")
            bad.append({**r, "why": ", ".join(why)})

    for b in bad:
        print(f"  ⚠ {b['file']} — {b['why']}")
    if not bad:
        print("  ✅ выбросов нет — корпус ровный")
        return 0

    print(f"\nвыбросов: {len(bad)} из {len(rows)}")
    if not redo:
        print("перезаписать только их: … wakeword-enroll.py --slug %s --audit --redo" % slug)
        return 1

    for b in bad:
        os.remove(b["path"])
        m = os.path.join(MASTERS, slug, b["file"])
        if os.path.exists(m):
            os.remove(m)
    print(f"удалено {len(bad)} — запусти обычную запись, она доберёт недостающие до нужного числа")
    return 0


def retrim(slug, train_dir) -> int:
    """Пересобрать УЧЕБНЫЕ клипы из оригиналов текущим алгоритмом резки.

    Ради этого оригиналы и хранятся отдельно. Резка — самая хрупкая часть стенда, её улучшают по
    живым находкам; без пересборки исправление досталось бы только следующему человеку, а уже
    записанный корпус остался бы с дефектом, ради которого владельца пришлось бы звать заново.
    ⚠️ Оригиналы НЕ трогаем: архив должен пережить любые наши улучшения.
    """
    master_dir = os.path.join(MASTERS, slug)
    files = clips(master_dir)
    if not files:
        print("оригиналов нет — пересобирать не из чего")
        return 1

    changed = []
    for f in files:
        with wave.open(os.path.join(master_dir, f)) as w:
            sr = w.getframerate()
            x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        # Пол шума берём из самого файла: живого замера комнаты здесь уже нет, а 10-й процентиль
        # огибающей — честная оценка того, что в этой записи было тишиной.
        noise = float(np.percentile(np.abs(x.astype(np.float32)), 10))
        cut, ok = trim_silence(x, noise)
        if not ok:
            continue
        before = len(x) / sr
        after = len(cut) / sr
        write_wav(os.path.join(train_dir, f), to_train_sr(cut), TRAIN_SR)
        if abs(before - after) > 0.05:
            changed.append((f, before, after))

    print(f"\n=== пересборка учебных клипов «{slug}» ===")
    print(f"обработано {len(files)}, изменилось {len(changed)}\n")
    for f, b, a_ in changed:
        print(f"  {f}: {b:.2f} с → {a_:.2f} с")
    return 0


def audition(slug, train_dir, play=False) -> int:
    """КОНТРОЛЬНАЯ ПРОСЛУШКА: собрать все записи в один монтаж и напечатать раскладку по секундам.

    Требование владельца 2026-08-01: *«такая контрольная прослушка должна быть в конечном
    инструменте поставки KLAS»*. Разбор по числам (`--audit`) ловит выбросы длительности, но
    «обкусано ли начало имени» числом не проверяется — это слышно, и только человеком. Значит
    прослушка не вспомогательный скрипт, а часть процедуры: записал → послушал всё → принял.

    Раскладка по секундам печатается для того, чтобы услышанное можно было НАЗВАТЬ: человек говорит
    «на 0:36 плохо», а не «где-то в середине что-то не так».
    ⚠️ Играет ЗВУК В КОМНАТЕ — вызывать только по прямой просьбе (правило владельца 2026-08-01).
    """
    master_dir = os.path.join(MASTERS, slug)
    src = master_dir if os.path.isdir(master_dir) and clips(master_dir) else train_dir
    files = clips(src)
    if not files:
        print("записей нет")
        return 1

    order = [tag for _, _, tag in SCRIPT]
    titles = {tag: text.split(",")[0].split("—")[0].strip() for _, text, tag in SCRIPT}
    by_tag = {t: [f for f in files if f"__{t}__" in f] for t in order}
    rest = [f for f in files if not any(f"__{t}__" in f for t in order)]
    if rest:
        by_tag["прочее"] = rest
        titles["прочее"] = "прочее"
        order.append("прочее")

    with wave.open(os.path.join(src, files[0])) as w:
        sr = w.getframerate()
    gap = np.zeros(int(0.40 * sr), dtype=np.int16)
    block_gap = np.zeros(int(1.20 * sr), dtype=np.int16)

    parts, pos, rows = [], 0.0, []
    for i, tag in enumerate(order):
        if not by_tag.get(tag):
            continue
        if parts:
            parts.append(block_gap)
            pos += len(block_gap) / sr
        rows.append((pos, f"── блок «{titles[tag]}» ({len(by_tag[tag])} шт.)", ""))
        for f in by_tag[tag]:
            with wave.open(os.path.join(src, f)) as w:
                x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
            # Оригинал режется ТЕКУЩИМ алгоритмом: слушать надо то, что пойдёт в обучение сейчас,
            # а не то, что было нарезано вчерашней версией резки.
            if src == master_dir:
                x = trim_silence(x, float(np.percentile(np.abs(x.astype(np.float32)), 10)))[0]
            rows.append((pos, f, f"{len(x) / sr:.2f} с"))
            parts += [x, gap]
            pos += (len(x) + len(gap)) / sr

    # ⛔ Монтаж кладём РЯДОМ С ОРИГИНАЛАМИ, а НЕ в учебный каталог. Первая версия писала его в
    # корпус — и шестидесятитрёхсекундная склейка всех записей лежала там как ещё один «пример
    # имени»; раскладка обучения забирает каталог целиком, так что в обучение уехал бы клип, где
    # имя звучит пятьдесят раз подряд. Поймано судьёй перед первым же пушем, до обучения.
    out = os.path.join(master_dir if os.path.isdir(master_dir) else train_dir, "_audition.wav")
    write_wav(out, np.concatenate(parts), sr)

    print(f"\n=== контрольная прослушка «{slug}» · {len(files)} записей · {pos:.0f} с ===")
    for t, name, dur in rows:
        m, s = divmod(t, 60)
        stamp = f"{int(m)}:{s:04.1f}"
        print(f"  {stamp}  {name} {dur}" if dur else f"\n  {stamp}  {name}")
    print(f"\nмонтаж: {out}")

    if play:
        print("⚠ играю в комнате…")
        subprocess.run(["powershell", "-NoProfile", "-Command",
                        f"(New-Object Media.SoundPlayer '{out}').PlaySync()"])
    else:
        print("послушать: … --slug %s --audition --play" % slug)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audition", action="store_true",
                    help="собрать монтаж всех записей и напечатать раскладку по секундам")
    ap.add_argument("--play", action="store_true", help="с --audition: проиграть в комнате")
    ap.add_argument("--retrim", action="store_true",
                    help="пересобрать учебные клипы из оригиналов текущей резкой")
    ap.add_argument("--selftest", action="store_true", help="проверить резку и пересчёт без микрофона")
    ap.add_argument("--audit", action="store_true", help="разобрать записанное, найти выбросы")
    ap.add_argument("--redo", action="store_true", help="с --audit: удалить выбросы под перезапись")
    ap.add_argument("--slug", default="jarvis", choices=sorted(WORD))
    ap.add_argument("--count", type=int, default=50, help="сколько ПРИНЯТЫХ записей нужно")
    ap.add_argument("--device", default=None)
    ap.add_argument("--dry", action="store_true", help="проверить тракт на трёх записях и уйти")
    a = ap.parse_args()

    if a.selftest:
        return selftest()

    word = WORD[a.slug]
    word_l = word.lower()
    train_dir = os.path.join(CORPUS, a.slug, "personal")
    master_dir = os.path.join(MASTERS, a.slug)
    os.makedirs(train_dir, exist_ok=True)
    os.makedirs(master_dir, exist_ok=True)

    if a.audition:
        return audition(a.slug, train_dir, play=a.play)

    if a.retrim:
        return retrim(a.slug, train_dir)

    if a.audit:
        return audit(a.slug, word_l, train_dir, redo=a.redo)

    wl = load_listener()
    device = wl.pick_mic(a.device)
    need = 3 if a.dry else a.count

    print(f"\n═══ ЗАПИСЬ ГОЛОСА для активатора «{word}» ═══")
    print(f"микрофон: {device}   ·   пишем {REC_SR} Гц   ·   нужно принятых: {need}")
    print(f"оригиналы: {master_dir}\nучебные:   {train_dir}\n")
    print(f"Говори ТОЛЬКО имя, отдельной фразой. Не «{word}, включи музыку» — только имя.")
    print("После каждой записи скажу, принято или переписываем. Ctrl+C — закончить досрочно.\n")

    plan = [(text, tag) for n, text, tag in SCRIPT for _ in range(n)]
    if len(plan) < need:
        plan += [plan[-1]] * (need - len(plan))
    plan = plan[:need]

    # ПРОДОЛЖЕНИЕ, а не начало заново. Сессия может прерваться (человека позвали, стенд починили
    # на ходу — так и случилось 2026-08-01), и заставлять человека переписывать уже принятое —
    # неуважение к его времени. Считаем по ФАЙЛАМ на диске, а не по манифесту: файл есть правда,
    # манифест лишь её описание.
    man_path = os.path.join(CORPUS, a.slug, "manifest.personal.json")
    have = clips(train_dir)
    manifest = []
    if have and os.path.exists(man_path):
        try:
            old = json.load(open(man_path, encoding="utf-8"))
            manifest = [c for c in old.get("clips", [])
                        if os.path.basename(c.get("file", "")) in set(have)]
        except Exception:      # noqa: BLE001
            manifest = []
    accepted = len(have)
    if accepted:
        print(f"↩ продолжаю: на диске уже {accepted} принятых записей\n")
        if accepted >= need:
            print("нужное число уже набрано — записывать нечего")
            return 0

    errbuf = []
    frames = mic_frames(device, errbuf)
    attempts = 0
    noise_win = []
    t0 = time.time()

    try:
        while accepted < need:
            prompt, tag = plan[accepted]
            print(f"[{accepted + 1}/{need}] {prompt}   → скажи «{word}»")

            ep = None
            buf = []
            pre = []
            verdict = None
            noise_now = 0.0
            for audio in frames:
                level = float(np.abs(audio).mean())
                if ep is None:
                    # ⛔ ПРЕДЗАПИСЬ. Пока меряется пол шума, звук всё равно КОПИТСЯ. Первая живая
                    # сессия 2026-08-01 показала, почему: человек читает подсказку и начинает
                    # говорить сразу, а стенд эти полсекунды выбрасывал — уши слышали «арвес»
                    # вместо «джарвис», и владелец переписывал запись за МОЮ ошибку. Отрезанное
                    # начало слова к тому же ядовито вдвойне: попади такой клип в обучение, модель
                    # выучила бы обрубок.
                    pre.append(audio)
                    if len(pre) > 10:
                        pre.pop(0)
                    # Пол шума меряем ПЕРЕД каждой записью: человек ходит по комнате, и порог,
                    # снятый один раз в начале, к середине сессии перестаёт соответствовать месту.
                    noise_win.append(level)
                    if len(noise_win) > 25:
                        noise_win.pop(0)
                    if len(noise_win) < 5:
                        continue
                    # Медиана, а не среднее: если человек уже заговорил в предзапись, среднее
                    # задерёт порог, а медиана шести кадров устоит.
                    noise_now = float(np.median(noise_win))
                    ep = wl.Endpointer(noise=noise_now, wait_sec=15.0, hang_sec=0.7, max_sec=4.0)
                    buf.extend(pre)
                    for p in pre:
                        verdict = ep.feed(float(np.abs(p).mean()))
                    continue
                buf.append(audio)
                verdict = ep.feed(level)
                if verdict in ("done", "max", "empty"):
                    break
            if verdict is None:
                print(f"  микрофон замолчал — прерываю. {''.join(errbuf)[:200]}")
                break
            if verdict == "empty":
                print("  тишина — жду ещё раз")
                continue

            attempts += 1
            raw = np.concatenate(buf)
            trimmed, ok_trim = trim_silence(raw, noise_now)
            if not ok_trim:
                print("  ничего громче шума не нашёл — говори чуть ближе")
                continue

            stamp = int(time.time() * 1000)
            train_tmp = os.path.join(train_dir, f"tmp-{stamp}.wav")
            train_sec = write_wav(train_tmp, to_train_sr(trimmed), TRAIN_SR)

            heard = heard_text(train_tmp)
            dist = levenshtein(heard, word_l)
            # Допуск как у охранника корпуса: имя ассистента ВНЕ словаря ушей, и точное совпадение
            # штрафовало бы исправные записи. Порог — 30% длины слова, но не меньше 2 правок.
            if dist <= max(2, round(len(word_l) * 0.3)):
                name = f"own__{tag}__{accepted:03d}"
                os.replace(train_tmp, os.path.join(train_dir, f"{name}.wav"))
                write_wav(os.path.join(master_dir, f"{name}.wav"), trimmed, REC_SR)
                manifest.append({
                    "file": f"personal/{name}.wav", "master": f"{name}.wav", "prompt": tag,
                    "heard": heard, "seconds": round(train_sec, 3), "distance": dist,
                    "raw_seconds": round(len(raw) / REC_SR, 3),
                })
                accepted += 1
                cut = len(raw) / REC_SR - train_sec
                print(f"  ✅ принято ({accepted}/{need}) · «{heard}» · {train_sec:.2f} с "
                      f"(срезано тишины {cut:.2f} с)")
            else:
                os.remove(train_tmp)
                print(f"  ↻ не разобрал (услышал «{heard}») — скажи ещё раз чуть чётче")
    except KeyboardInterrupt:
        print("\nОстановлено вручную.")

    # Манифест обязан описывать ВСЁ, что лежит на диске. Если прошлый заход был убит и не успел
    # записать свои строки, файлы остались, а описание — нет; молча пропустить их значило бы
    # соврать о составе корпуса. Достраиваем недостающие записи и честно помечаем, откуда они.
    known = {os.path.basename(c.get("file", "")) for c in manifest}
    for f_name in clips(train_dir):
        if f_name not in known:
            with wave.open(os.path.join(train_dir, f_name)) as w:
                sec = w.getnframes() / w.getframerate()
            manifest.append({"file": f"personal/{f_name}", "master": f_name,
                             "prompt": f_name.split("__")[1] if "__" in f_name else "?",
                             "heard": None, "seconds": round(sec, 3),
                             "recovered": "заход прерван — строка восстановлена по файлу"})

    if manifest and not a.dry:
        with open(man_path, "w", encoding="utf-8") as f:
            json.dump({"word": word, "slug": a.slug, "device": device, "record_sr": REC_SR,
                       "clips": manifest}, f, ensure_ascii=False, indent=2)
    mins = (time.time() - t0) / 60
    print(f"\n═══ Готово: принято {accepted} из {attempts} попыток за {mins:.1f} мин ═══")
    if accepted and not a.dry:
        durs = [c["seconds"] for c in manifest]
        print(f"Длительность клипов: медиана {np.median(durs):.2f} с (мин {min(durs):.2f}, макс {max(durs):.2f})")
        print(f"Оригиналы {REC_SR} Гц: {master_dir}")
        print("Дальше — раскладка обучения с личными клипами (план 23, шаг 4).")
    return 0 if accepted else 1


if __name__ == "__main__":
    raise SystemExit(main())
