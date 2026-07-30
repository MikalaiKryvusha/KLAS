#!/bin/bash
# Запуск обучения голоса Вихрова (Piper VITS) в WSL.
#
# Зачем файлом, а не строкой в `wsl bash -lc "..."`:
#   1) канон KLAS — текст передаётся ФАЙЛАМИ, а не аргументами (AGENT_GUIDE.md, EXP-0035);
#   2) `setsid nohup ... &` в WSL НЕ переживает выхода из `wsl`: дистрибутив сворачивается и
#      уносит отсоединённый процесс (вечер 2026-07-30 — лог остался нулевого размера, обучение
#      не стартовало ни разу). Процесс держится ЗАДАЧЕЙ ХАРНЕССА (run_in_background), а файл
#      нужен только чтобы команда была одна и воспроизводимая.
#
# Параметры замера подачи данных: корпус лежит на Linux-диске (/opt), а не на /mnt/f —
# при чтении через прослойку /mnt GPU простаивала на 74% (см. шапку train_piper.py).
#
# [NOT-TESTED] — маркер снимается после прогона, давшего слышимый голос.
set -euo pipefail

STEPS="${1:-3000}"
BATCH="${2:-16}"
WORKERS="${3:-6}"

OUT=/opt/piper_train/vihrov
mkdir -p "$OUT"
LOG="$OUT/train.log"

# ─────────────────────────────────────────────────────────────────────────────
# ОХРАННИК МЕСТА НА ХОСТ-ДИСКЕ. Вечер 2026-07-30: обучение выело диск C: досуха,
# ext4 внутри ext4.vhdx поймал ошибки записи и ушёл в аварийный режим — дистрибутив
# перестал запускаться вовсе (`getpwnam(root) failed 5`, `Wsl/Service/CreateInstance/E_FAIL`).
#
# ⚠️ ПОЧЕМУ LINUX НЕ ПРЕДУПРЕДИЛ: виртуальный диск объявлен на 1 ТБ, поэтому `df /` внутри WSL
# показывал 874 ГБ свободных, когда на C: оставалось 7 ГБ. Изнутри дистрибутива настоящее
# ограничение НЕ ВИДНО — видно только через /mnt/c, то есть через сам хост-диск.
#
# Сколько ест обучение: Piper держит ДВА монитора качества (val_mel и val_mos), у каждого
# save_top_k=5, плюс last ⇒ до 11 чекпойнтов по 846 МБ = ~9.3 ГБ ЗА ПРОГОН. Прогоны копятся.
MIN_FREE_GB=25
free_gb=$(df -BG --output=avail /mnt/c 2>/dev/null | tail -1 | tr -dc '0-9')
used_gb=$(du -sBG /opt/piper_train 2>/dev/null | cut -f1 | tr -dc '0-9')
echo "=== место на хост-диске C: свободно ${free_gb} ГБ · прошлые прогоны занимают ${used_gb:-0} ГБ"
if [ -n "$free_gb" ] && [ "$free_gb" -lt "$MIN_FREE_GB" ]; then
  echo "⛔ СТОП: на C: свободно ${free_gb} ГБ, нужно минимум ${MIN_FREE_GB}."
  echo "   Один прогон съедает до 9.3 ГБ чекпойнтами, и переполнение C: ЛОМАЕТ ВЕСЬ ДИСТРИБУТИВ,"
  echo "   а не просто останавливает обучение."
  echo "   Освободить: find /opt/piper_train/vihrov/lightning_logs -name '*.ckpt' -delete"
  echo "   Вернуть место Windows: wsl --shutdown, затем wsl --manage Ubuntu --set-sparse true"
  exit 2
fi
# ─────────────────────────────────────────────────────────────────────────────

cd /opt/piper1-gpl
echo "=== старт обучения: steps=$STEPS batch=$BATCH workers=$WORKERS ===" | tee -a "$LOG"
date -Is | tee -a "$LOG"

# stdbuf -oL: без него python буферизует stdout блоками и лог кажется мёртвым (ложный «завис»)
exec stdbuf -oL -eL /opt/piper1-gpl/.venv/bin/python \
  /mnt/f/KLAS/tools/voice/train_piper.py \
  --steps "$STEPS" \
  --batch "$BATCH" \
  --workers "$WORKERS" \
  --name vihrov \
  --dataset /opt/dataset_vihrov 2>&1 | tee -a "$LOG"
