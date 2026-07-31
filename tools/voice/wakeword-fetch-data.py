# tools/voice/wakeword-fetch-data.py — ЗАГРУЗЧИК данных обучения активатора (план 19, шаг 2).
#
# Что качает и почему именно это — обосновано разведкой `researches/22`:
#   1. mit_rirs   — импульсные характеристики 271 реальной комнаты (30.5 МБ). Реверберация: без неё
#                   детектор учится на стерильной студийной записи и глохнет в живой комнате.
#   2. features   — ПРЕДВЫЧИСЛЕННЫЕ негативы ACAV100M, ~2000 часов речи/шума/музыки (16.09 ГБ).
#                   Именно они снимают страшилку «нужно 30 000 часов звука»: openWakeWord принимает
#                   .npy с эмбеддингами через ключ конфига `feature_data_files`, а не каталог аудио.
#   3. validation — набор проверки ЛОЖНЫХ СРАБАТЫВАНИЙ, ~11 ч (172 МБ). Без него метрика «ложных в
#                   час» неизмерима, а она половина приёмки сферы.
#   4. background — фоновый шум (шард AudioSet) и музыка (FMA small) для аугментации.
#
# ⚠️ ЛИЦЕНЗИИ СМЕШАННЫЕ: эти наборы годятся только для НЕкоммерческого личного использования
#    (`researches/22` §2). Для KLAS это ровно наш случай; в продукт такая модель не поедет.
#
# ⚠️ КЕШ УВОДИТСЯ НА F:. По умолчанию huggingface_hub кладёт всё в C:\Users\...\.cache\huggingface,
#    а на C: свободно 38 ГБ при загрузке в 16 — риск забить системный диск. Здесь и HF_HOME, и
#    local_dir указывают на F:, и local_dir означает «класть файлы НАПРЯМУЮ», без второй копии в кеше.
#
# ⚠️ Пути внутри чужих репозиториев НЕ УГАДЫВАЮТСЯ: скрипт спрашивает список файлов у API и выбирает
#    нужный по имени. Угаданный путь ломается молча — при переносе файла апстримом мы получили бы
#    404 вместо данных (PHILOSOPHY: наблюдение вместо домысла).
#
# Загрузка ВОЗОБНОВЛЯЕМА: huggingface_hub докачивает, поэтому обрыв связи не начинает всё заново.
# Повторный запуск идемпотентен — уже скачанное пропускается.
#
# Запуск: F:\KLAS\voice\venv-wakeword\Scripts\python.exe tools/voice/wakeword-fetch-data.py [--skip-big]
#
# [NOT-TESTED] — родился 2026-07-31.

import os
import sys
from pathlib import Path

DATA_ROOT = Path(r"F:\KLAS\voice\wakeword\data")

# HF_HOME обязан быть выставлен ДО импорта huggingface_hub — библиотека читает его при загрузке модуля.
os.environ.setdefault("HF_HOME", str(DATA_ROOT / "_hf_home"))
DATA_ROOT.mkdir(parents=True, exist_ok=True)

from huggingface_hub import HfApi, hf_hub_download, snapshot_download  # noqa: E402

api = HfApi()
SKIP_BIG = "--skip-big" in sys.argv


def mb(path: Path) -> str:
    """Размер файла или каталога в человекочитаемом виде — он же улика, что скачалось не пустое."""
    if path.is_file():
        n = path.stat().st_size
    else:
        n = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
    return f"{n / 1024**3:.2f} ГБ" if n >= 1024**3 else f"{n / 1024**2:.1f} МБ"


def find_in_repo(repo: str, needle: str) -> str | None:
    """Найти путь файла в репозитории по фрагменту имени. Возвращает None, если не нашёлся, —
    и это ЧЕСТНЕЕ, чем подставить угаданный путь: вызывающий увидит пропуск, а не тихий 404."""
    try:
        files = api.list_repo_files(repo, repo_type="dataset")
    except Exception as e:                                   # noqa: BLE001
        print(f"  ⚠️ не удалось получить список файлов {repo}: {e}")
        return None
    hits = [f for f in files if needle in f]
    if not hits:
        print(f"  ⚠️ в {repo} нет файла с фрагментом «{needle}» — пропускаю")
        return None
    hits.sort()                                              # детерминированный выбор
    return hits[0]


def get_file(repo: str, filename: str, dest: Path, label: str) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    print(f"\n▶ {label}\n  {repo} :: {filename}")
    p = Path(hf_hub_download(repo, filename, repo_type="dataset", local_dir=str(dest)))
    print(f"  ✅ {p.name} — {mb(p)}")


# --- 1. Импульсные характеристики комнат (30.5 МБ) -------------------------------------------------
print("=" * 70)
print("1/4 · Импульсные характеристики 271 реальной комнаты (MIT)")
rirs = DATA_ROOT / "mit_rirs"
snapshot_download(
    "davidscripka/MIT_environmental_impulse_responses",
    repo_type="dataset", local_dir=str(rirs), allow_patterns=["*.wav"],
)
n_rirs = len(list(rirs.rglob("*.wav")))
print(f"  ✅ {n_rirs} файлов — {mb(rirs)}")

# --- 2. Набор проверки ложных срабатываний (172 МБ) ------------------------------------------------
print("\n" + "=" * 70)
print("2/4 · Набор проверки ЛОЖНЫХ СРАБАТЫВАНИЙ (~11 ч)")
get_file("davidscripka/openwakeword_features", "validation_set_features.npy",
         DATA_ROOT / "features", "набор проверки")

# --- 3. Фоновый шум и музыка -----------------------------------------------------------------------
print("\n" + "=" * 70)
print("3/4 · Фоновый шум (шард AudioSet) и музыка (FMA)")
audioset = find_in_repo("agkphysics/AudioSet", "bal_train09.tar")
if audioset:
    get_file("agkphysics/AudioSet", audioset, DATA_ROOT / "audioset", "шард AudioSet")

fma = find_in_repo("rudraml/fma", "fma_small")
if fma:
    get_file("rudraml/fma", fma, DATA_ROOT / "fma", "музыка FMA small")

# --- 4. Главный файл: предвычисленные негативы (16.09 ГБ) ------------------------------------------
# Идёт ПОСЛЕДНИМ намеренно: если связь оборвётся, мелкие и быстрые наборы уже лежат, и работа по
# аугментации не ждёт шестнадцати гигабайт.
print("\n" + "=" * 70)
if SKIP_BIG:
    print("4/4 · ПРОПУЩЕНО (--skip-big): предвычисленные негативы ACAV100M, 16.09 ГБ")
else:
    print("4/4 · Предвычисленные негативы ACAV100M (~2000 ч) — 16.09 ГБ, это надолго")
    get_file("davidscripka/openwakeword_features",
             "openwakeword_features_ACAV100M_2000_hrs_16bit.npy",
             DATA_ROOT / "features", "негативы ACAV100M")

# --- Охранник --------------------------------------------------------------------------------------
# Класс EXP-0042: охранник, считающий пустоту успехом, — не охранник. Проверяем то, чем загрузка
# может тихо оказаться негодной: каталог есть, а файлов нет, или файл есть, но обрезан.
print("\n" + "=" * 70)
problems = []
if n_rirs < 200:
    problems.append(f"импульсных характеристик всего {n_rirs}, ожидалось ~271")
val = DATA_ROOT / "features" / "validation_set_features.npy"
if not val.exists() or val.stat().st_size < 150 * 1024**2:
    problems.append("набор проверки ложных срабатываний отсутствует или обрезан (<150 МБ)")
if not SKIP_BIG:
    big = DATA_ROOT / "features" / "openwakeword_features_ACAV100M_2000_hrs_16bit.npy"
    if not big.exists() or big.stat().st_size < 16 * 1024**3:
        problems.append("файл негативов ACAV100M отсутствует или обрезан (<16 ГБ)")

print(f"Итого в {DATA_ROOT}: {mb(DATA_ROOT)}")
if problems:
    print("❌ ЗАГРУЗКА НЕПОЛНА: " + " · ".join(problems))
    sys.exit(1)
print("✅ Данные обучения на месте.")
