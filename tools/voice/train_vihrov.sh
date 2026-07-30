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
