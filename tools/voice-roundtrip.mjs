#!/usr/bin/env node
// tools/voice-roundtrip.mjs — автономная проверка ВСЕГО аудио-контура KLAS (фаза Г2, plans/12):
// текст → Г1-синтез (Silero, voice-say) → Г2-распознавание (GigaAM, voice-hear) → сравнение слов.
// Не нужны ни микрофон, ни человек — агент сам меряет качество «рот+уши» по доле совпавших слов.
//
// Использование:
//   node tools/voice-roundtrip.mjs                → встроенный набор из 10 разнообразных фраз
//   node tools/voice-roundtrip.mjs "своя фраза"   → одна фраза
// Критерий Г2 (plans/12): совпадение слов ≥ 90% на встроенном наборе.

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';

const OUT_DIR = 'F:\\KLAS\\voice\\out';
const HERE = import.meta.dirname;

// Набор покрывает: приветствие, числа, дату, техтермины, имена, вопрос, длинную фразу
const PHRASES = process.argv[2] ? [process.argv[2]] : [
  'Привет, Криник! Я твой локальный ассистент.',
  'Сегодня семнадцатое июля, пятница.',
  'На видеокарте шестнадцать гигабайт видеопамяти.',
  'Запусти сервер и проверь здоровье системы.',
  'Модель квэн работает быстрее геммы в агентных задачах.',
  'Какая погода в Минске в июле?',
  'Порт восемь тысяч восемьдесят занят другим процессом.',
  'Сохрани файл и закоммить изменения в репозиторий.',
  'Локальная википедия доступна без интернета.',
  'Стабильность важнее ума, а ум важнее скорости.',
];

// Нормализация для сравнения: регистр, ё→е, пунктуация вон, схлопнуть пробелы
const norm = (s) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim();

let totalRef = 0, totalHit = 0;
const rows = [];
for (const [i, phrase] of PHRASES.entries()) {
  const wav = path.join(OUT_DIR, `roundtrip-${i}.wav`);
  const say = spawnSync('node', [path.join(HERE, 'voice-say.mjs'), phrase, '--out', wav], { encoding: 'utf8', timeout: 300_000, windowsHide: true });
  if (say.status !== 0) { rows.push({ phrase, got: `ОШИБКА СИНТЕЗА: ${say.stderr?.slice(-120)}`, pct: 0 }); continue; }
  const hear = spawnSync('node', [path.join(HERE, 'voice-hear.mjs'), wav], { encoding: 'utf8', timeout: 300_000, windowsHide: true });
  if (hear.status !== 0) { rows.push({ phrase, got: `ОШИБКА РАСПОЗНАВАНИЯ: ${hear.stderr?.slice(-120)}`, pct: 0 }); continue; }
  const got = hear.stdout.trim();
  // Доля слов исходника, найденных в распознанном (порядок не штрафуем — критерий по словам)
  const ref = norm(phrase).split(' ');
  const gotWords = new Set(norm(got).split(' '));
  const hit = ref.filter((w) => gotWords.has(w)).length;
  totalRef += ref.length; totalHit += hit;
  rows.push({ phrase, got, pct: Math.round((hit / ref.length) * 100) });
  rmSync(wav, { force: true });
}

for (const r of rows) console.log(`[${String(r.pct).padStart(3)}%] «${r.phrase}» → «${r.got}»`);
const total = totalRef ? Math.round((totalHit / totalRef) * 100) : 0;
console.log(`\nИТОГ round-trip: ${total}% слов (${totalHit}/${totalRef}) · критерий Г2: ≥90%`);
process.exit(total >= 90 ? 0 : 1);
