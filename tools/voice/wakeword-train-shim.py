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

# Делегируем настоящему обучателю. sys.argv уже содержит наши аргументы: runpy отдаст их модулю
# как есть, а `run_name='__main__'` заставит его выполнить свой блок разбора аргументов.
sys.argv[0] = "openwakeword.train"
runpy.run_module("openwakeword.train", run_name="__main__")
