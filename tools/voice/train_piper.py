# -*- coding: utf-8 -*-
"""
Запуск ДООБУЧЕНИЯ голоса Piper VITS от готового чекпойнта.

Зачем отдельный запускатель, а не команда из документации: у неё на нашем стеке две гранаты,
и обе взрываются молча или невнятно.

ГРАНАТА 1 — безопасная загрузка чекпойнта.
    PyTorch с версии 2.6 грузит `torch.load(weights_only=True)` по умолчанию. В чекпойнтах Piper
    (rhasspy/piper-checkpoints, эпоха обучения 2023 года) внутри гиперпараметров лежит объект
    `pathlib.PosixPath`, которого нет в белом списке безопасных типов. Lightning падает с
    `UnpicklingError: Unsupported global: GLOBAL pathlib.PosixPath` ещё ДО начала обучения.
    Лечение: явно разрешить эти типы. Делаем это осознанно — источник чекпойнта известный
    (официальный репозиторий Piper), файл скачан нами.

ГРАНАТА 2 — `--ckpt_path` это НЕ «взять веса», а «продолжить обучение».
    Lightning восстанавливает из чекпойнта и веса, И состояние обучателя, И номер шага. Отсюда две
    беды сразу:
      * чекпойнт `ruslan/medium` стоит на шаге 1 724 372, поэтому наивный `--trainer.max_steps 5000`
        завершает обучение МГНОВЕННО, не сделав ни шага, — и выглядит это как «обучение прошло
        успешно». Классическая тихая ложь;
      * гиперпараметры старого чекпойнта — это ЦЕЛИКОМ argparse-пространство обучателя 2023 года
        (`sample_bytes`, `gpus`, `tpu_cores`, `amp_level`…), и новый `piper1-gpl` их не принимает:
        `error: Subcommand 'fit' does not accept option 'model.sample_bytes'`.

    ЛЕЧЕНИЕ — ШТАТНОЕ, а не костыль: у новой модели есть параметр **`warmstart_ckpt`**
    (`vits/lightning.py:90`), который грузит ТОЛЬКО ВЕСА (`_warmstart_from_ckpt`), не трогая ни
    состояние обучателя, ни счётчик шагов, ни чужие гиперпараметры. Это и есть «дообучение от
    чекпойнта» в терминах нового Piper. `--ckpt_path` для нашей задачи — неверный инструмент.

Использование:
    python tools/voice/train_piper.py --steps 4000 [--batch 8] [--name vihrov]

[NOT-TESTED] — маркер снимается после первого прогона, дающего слышимый голос.
"""
import argparse
import pathlib
import sys

import torch

# ГРАНАТА 1 — до любого импорта Lightning
torch.serialization.add_safe_globals([pathlib.PosixPath, pathlib.WindowsPath,
                                      pathlib.PurePosixPath, pathlib.PureWindowsPath])

p = argparse.ArgumentParser()
p.add_argument("--name", default="vihrov")
p.add_argument("--dataset", default="/mnt/f/KLAS/voice/dataset_vihrov")
p.add_argument("--ckpt", default="/opt/piper_ckpt/ru/ru_RU/ruslan/medium/epoch=2436-step=1724372.ckpt")
p.add_argument("--out", default=None)
p.add_argument("--steps", type=int, default=4000, help="сколько шагов обучать (счётчик с нуля: warmstart берёт только веса)")
p.add_argument("--batch", type=int, default=8)
# ⚠️ Подача данных, а не вычисления, оказалась узким местом: при одном потоке и корпусе на диске F
# (читается из WSL через прослойку /mnt) GPU была загружена на 26%. Держать корпус на Linux-диске
# и давать несколько потоков — разница в разы, а не в проценты.
p.add_argument("--workers", type=int, default=8)
p.add_argument("--espeak", default="ru")
p.add_argument("--sr", type=int, default=22050)
args = p.parse_args()

out = args.out or f"/opt/piper_train/{args.name}"
pathlib.Path(out, "cache").mkdir(parents=True, exist_ok=True)

ckpt = torch.load(args.ckpt, weights_only=True, map_location="cpu")
print(f"=== чекпойнт-донор: шаг {ckpt.get('global_step')}, тензоров {len(ckpt.get('state_dict', {}))} ===", flush=True)
print(f"=== берём ТОЛЬКО ВЕСА (warmstart), обучаем {args.steps} шагов со счётчиком с нуля ===", flush=True)
del ckpt

sys.argv = [
    "piper.train", "fit",
    "--data.voice_name", args.name,
    "--data.csv_path", f"{args.dataset}/metadata.csv",
    "--data.audio_dir", f"{args.dataset}/wav",
    "--data.espeak_voice", args.espeak,
    "--data.cache_dir", f"{out}/cache",
    "--data.config_path", f"{out}/config.json",
    "--data.batch_size", str(args.batch),
    "--data.num_workers", str(args.workers),
    "--model.sample_rate", str(args.sr),
    # ⬇️ ключевая строка: веса донора, БЕЗ состояния обучателя и без его гиперпараметров
    "--model.warmstart_ckpt", args.ckpt,
    "--trainer.max_steps", str(args.steps),
    "--trainer.devices", "1",
    "--trainer.accelerator", "gpu",
    "--trainer.default_root_dir", out,
]
print("=== " + " ".join(sys.argv) + " ===", flush=True)

from piper.train.__main__ import main  # noqa: E402  (импорт ПОСЛЕ add_safe_globals)
main()
