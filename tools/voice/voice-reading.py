# tools/voice/voice-reading.py — ДЛИННАЯ НАЧИТКА голоса владельца (биометрия + клонирование).
#
# Зачем отдельно от `wakeword-enroll.py`. Там записывается ОДНО слово полусекундными кусками, и
# каждый кусок судят уши; здесь — связная речь блоками по полминуты, и судить её распознавателем
# бессмысленно: длинный текст он и так разберёт, а качество записи это не докажет. Разные задачи —
# разные стенды; общая у них только машинерия микрофона, и она импортируется, а не копируется.
#
# Что даёт запись:
#   · биометрию (`plans/09`) — отпечаток голоса владельца, чтобы система отличала его от чужого;
#   · материал для клонирования (`plans/18`).
# Текст — `docs/voice_reading_ru.md`, там же объяснено, почему стилометрию отсюда снять нельзя.
#
# ⛔ ЗАПИСЬ СОДЕРЖИТ ИМЕНА АССИСТЕНТОВ и потому НЕПРИГОДНА как отрицательный фон активаторов.
# Кладём её в `voice/sources/own_voice/reading/`, а не в корпус, — чтобы не смешалась случайно.
#
# ⚠️ Инструмент ПИШЕТ МИКРОФОН. Правило владельца 2026-08-01: предупреждать и получать подтверждение.
#
# Запуск: F:\KLAS\voice\venv-wakeword\Scripts\python.exe tools/voice/voice-reading.py
#         … --blocks 1,2,3   (только часть)      … --selftest (разбор текста без микрофона)
#
# [NOT-TESTED]

import argparse
import importlib.util
import json
import os
import re
import sys
import time

import numpy as np

for _s in (sys.stdout, sys.stderr):
    _s.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
# ⚠️ Текст лежит в `docs/`, а НЕ в `voice/`: весь каталог `voice/` вне git (там тяжёлые модели и
# личные записи), и текст начитки, положенный туда, исчез бы у всякого, кто поднимет KLAS у себя.
# Процедура обязана приезжать вместе с репозиторием — иначе она не процедура, а наша самоделка.
TEXT = r"F:\KLAS\docs\voice_reading_ru.md"
OUT = r"F:\KLAS\voice\sources\own_voice\reading"


def load_enroll():
    """Микрофон, запись wav и обрезка тишины берутся у соседнего стенда. Вторая копия той же
    машинерии разъезжается молча — и записи начнут резаться по-разному."""
    spec = importlib.util.spec_from_file_location("we", os.path.join(HERE, "wakeword-enroll.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def parse_text(path):
    """Разобрать разметку на блоки: `### N. заголовок` + абзацы под ним.

    Служебное выбрасывается намеренно: цитаты (`>`) — это предупреждения агенту, курсив в конце —
    прощание, строки `**Как читать:**` — инструкция. Прочитать их вслух значило бы записать
    техническую справку голосом владельца и потом искать, почему клон разговаривает документацией.
    """
    blocks = []
    cur = None
    for line in open(path, encoding="utf-8").read().splitlines():
        s = line.strip()
        m = re.match(r"^###\s+(\d+)\.\s+(.+)$", s)
        if m:
            cur = {"n": int(m.group(1)), "title": m.group(2).strip(), "paras": []}
            blocks.append(cur)
            continue
        if cur is None or not s or s.startswith((">", "#", "---", "**", "*")):
            continue
        cur["paras"].append(s)
    return [b for b in blocks if b["paras"]]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true", help="разобрать текст без микрофона")
    ap.add_argument("--blocks", default=None, help="через запятую, например 5,6 — записать только их")
    ap.add_argument("--device", default=None)
    ap.add_argument("--hang", type=float, default=2.5,
                    help="сколько секунд тишины считать концом блока (внутри абзаца паузы короче)")
    a = ap.parse_args()

    blocks = parse_text(TEXT)

    if a.selftest:
        print("\n=== selftest voice-reading ===")
        ok = len(blocks) == 7
        print(f"  {'✅' if ok else '❌'} блоков найдено: {len(blocks)} (ожидалось 7)")
        words = sum(len(p.split()) for b in blocks for p in b["paras"])
        # Темп чтения вслух — около 130 слов в минуту; отсюда и оценка длительности.
        est = words / 130
        ok2 = 2.5 <= est <= 6.0
        print(f"  {'✅' if ok2 else '❌'} слов {words} ≈ {est:.1f} мин чистой речи (нужно 2.5–6)")
        srv = [p for b in blocks for p in b["paras"] if p.startswith(("**", ">", "*"))]
        ok3 = not srv
        print(f"  {'✅' if ok3 else '❌'} служебные строки не попали в текст для чтения")
        for b in blocks:
            print(f"     {b['n']}. {b['title']} — {len(b['paras'])} абз., "
                  f"{sum(len(p.split()) for p in b['paras'])} слов")
        good = ok and ok2 and ok3
        print(f"\n{[ok, ok2, ok3].count(True)}/3 " + ("— текст разобран" if good else "— ПРОВАЛ"))
        return 0 if good else 1

    if a.blocks:
        want = {int(x) for x in a.blocks.split(",")}
        blocks = [b for b in blocks if b["n"] in want]

    we = load_enroll()
    device = we.load_listener().pick_mic(a.device)
    os.makedirs(OUT, exist_ok=True)

    print(f"\n═══ ДЛИННАЯ НАЧИТКА — биометрия и клон голоса ═══")
    print(f"микрофон: {device}   ·   {we.REC_SR} Гц   ·   блоков: {len(blocks)}")
    print(f"пишем в: {OUT}\n")
    print("Читай обычным домашним голосом, не «дикторски». Сбился — перечитай предложение,")
    print(f"лишнее вырежется. Блок заканчивается сам после {a.hang:.1f} с тишины.\n")

    errbuf = []
    frames = we.mic_frames(device, errbuf)
    done = []
    t0 = time.time()

    try:
        for b in blocks:
            print("─" * 78)
            print(f"БЛОК {b['n']}. {b['title']}\n")
            for p in b["paras"]:
                print(f"  {p}\n")
            input("  ⏎ Enter — начинаю запись этого блока ")

            ep = None
            buf = []
            noise_win = []
            noise_now = 0.0
            verdict = None
            for audio in frames:
                level = float(np.abs(audio).mean())
                if ep is None:
                    noise_win.append(level)
                    if len(noise_win) > 25:
                        noise_win.pop(0)
                    if len(noise_win) < 6:
                        continue
                    noise_now = float(np.median(noise_win))
                    # Порог конца блока щедрый: человек, читающий абзац, делает паузы на знаках
                    # препинания, и жадный автомат обрезал бы его на первой же запятой.
                    ep = we.load_listener().Endpointer(
                        noise=noise_now, wait_sec=20.0, hang_sec=a.hang, max_sec=180.0)
                    print("  🎙  пишу…")
                buf.append(audio)
                verdict = ep.feed(level)
                if verdict in ("done", "max", "empty"):
                    break
            if verdict is None:
                print(f"  микрофон замолчал — прерываю. {''.join(errbuf)[:200]}")
                break
            if verdict == "empty":
                print("  тишина — блок пропущен, вернёмся к нему потом")
                continue

            raw = np.concatenate(buf)
            trimmed, ok_trim = we.trim_silence(raw, noise_now)
            keep = trimmed if ok_trim else raw
            name = f"reading__{b['n']:02d}.wav"
            sec = we.write_wav(os.path.join(OUT, name), keep, we.REC_SR)
            done.append({"file": name, "block": b["n"], "title": b["title"],
                         "seconds": round(sec, 2), "words": sum(len(p.split()) for p in b["paras"])})
            print(f"  ✅ {name} · {sec:.1f} с\n")
    except KeyboardInterrupt:
        print("\nОстановлено вручную.")

    if done:
        total = sum(d["seconds"] for d in done)
        with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump({"device": device, "sample_rate": we.REC_SR, "blocks": done},
                      f, ensure_ascii=False, indent=2)
        print(f"═══ Записано {len(done)} блоков · {total / 60:.1f} мин речи "
              f"за {(time.time() - t0) / 60:.1f} мин ═══")
        print("Биометрии хватает от 30 с; остальное — запас для клонирования (`plans/18`).")
    return 0 if done else 1


if __name__ == "__main__":
    raise SystemExit(main())
