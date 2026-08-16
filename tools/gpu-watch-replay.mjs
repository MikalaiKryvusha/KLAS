#!/usr/bin/env node
// gpu-watch-replay.mjs — офлайн-прогон правил «карта занята» ПО ЖУРНАЛУ наблюдателя.
// Шаг Ш5 плана `plans/28` (фаза 1 эпика 26).
//
//   node tools/gpu-watch-replay.mjs                      # все журналы logs/gpu-watch/*.jsonl
//   node tools/gpu-watch-replay.mjs logs/gpu-watch/2026-08-16.jsonl
//   node tools/gpu-watch-replay.mjs --episodes logs/gpu-watch/episodes.json
//   node tools/gpu-watch-replay.mjs --selftest
//
// ЗАЧЕМ ОН СУЩЕСТВУЕТ. Датчик пишет СЫРЫЕ числа и ни одного вердикта (решение конструкции 2
// `plans/28`). Значит порог можно передумать сколько угодно раз, не собирая данные заново: правку
// порога проверяет ЭТОТ прогон по уже записанному дню, а не следующие сутки ожидания.
//
// ЧТО ЗНАЧАТ ДВЕ ОШИБКИ — они НЕ равноценны, и таблица считает их раздельно:
//   • ложная тревога  (правило говорит «занято», а владелец не трогал карту) — KLAS никогда не
//     загрузит модель и весь эпик обесценится;
//   • ПРОПУСК        (правило говорит «свободно», а владелец играет или рендерит) — KLAS отнимает
//     карту у владельца. Это анти-критерий эпика: одного случая довольно, чтобы правило забраковать.
//
// РАЗМЕТКА ЭПИЗОДОВ — `logs/gpu-watch/episodes.json` (шаг Ш4), массив:
//   [{ "from": "2026-08-16T20:10:00+03:00", "to": "...", "class": "game", "note": "..." }]
// Классы: game · render · video (владелец на карте) · idle · work-nogpu (карта свободна).
// Разметки нет — инструмент всё равно печатает сводку журнала и подсказывает кандидатов в эпизоды.

import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = 'logs/gpu-watch';

// Классы эпизодов и ожидаемый от правила вердикт.
const BUSY_CLASSES = new Set(['game', 'render', 'video']);
const FREE_CLASSES = new Set(['idle', 'work-nogpu']);

// Наши собственные процессы на карте: их присутствие НИКОГДА не значит «владелец занял карту».
const OURS = new Set(['llama-server.exe', 'llama-swap.exe', 'ollama.exe']);

// Всё, что живёт на карте всегда: рабочий стол, оболочка, трей, браузеры, оверлеи. Список нужен
// ТОЛЬКО правилу A — чтобы показать его в самом выгодном свете; сам эпик списками имён не живёт
// (риск «список приложений сгниёт», `plans/26`).
const DESKTOP = new Set([
  'dwm.exe', 'explorer.exe', 'ShellExperienceHost.exe', 'ShellHost.exe', 'TextInputHost.exe',
  'ApplicationFrameHost.exe', 'SystemSettings.exe', 'CrossDeviceResume.exe', 'SearchHost.exe',
  'StartMenuExperienceHost.exe', 'chrome.exe', 'msedge.exe', 'firefox.exe', 'Code.exe',
  'NVIDIA Overlay.exe', 'NVIDIA Broadcast.exe', 'EdgeGameAssist.exe', 'ArmouryCrate.exe',
  'lghub.exe', 'lghub_system_tray.exe', 'NordVPN.exe', 'Docker Desktop.exe', 'parsecd.exe',
  'steamwebhelper.exe', 'PhoneExperienceHost.exe', 'SnippingTool.exe', 'Telegram.exe',
  '[Insufficient Permissions]',
]);

// ─── Правила-кандидаты (три варианта вопроса Q1 из `interviews/013`) ──────────────────────────
// Каждое получает состояние карты в момент времени и отвечает «карта занята владельцем?».
//
// Поле `needs` — ВХОДЫ, без которых правило судить НЕЛЬЗЯ. Оно появилось 2026-08-16 вместе с
// контейнерным наблюдателем (`gpu-manager`): из докера сеансовые величины владельца недостижимы
// по устройству, и правило на `fs` там молча вычислялось бы в «никогда не занято» — то есть
// показало бы ноль ложных тревог и выглядело бы ЛУЧШЕ всех, ничего не измерив. Отсутствие входа
// обязано дисквалифицировать правило, а не награждать его.
function makeRules(baselineMiB) {
  return [
    {
      key: 'A',
      title: 'любой чужой процесс на карте',
      note: 'вариант Q1-A интервью 013',
      needs: ['procs'],
      fn: (s) => [...s.procs].some((p) => !OURS.has(p)),
    },
    {
      key: 'A-lite',
      title: 'чужой процесс ВНЕ списка рабочего стола',
      note: 'A, смягчённое списком имён — показывает цену такого списка',
      needs: ['procs'],
      fn: (s) => [...s.procs].some((p) => !OURS.has(p) && !DESKTOP.has(p)),
    },
    {
      key: 'B',
      title: `память > базовой на 1024 МиБ ИЛИ утилизация >= 30%`,
      note: 'вариант Q1-B интервью 013',
      needs: [],
      fn: (s) => s.mem_used - baselineMiB >= 1024 || s.util_gpu >= 30,
    },
    {
      key: 'B-util',
      title: 'утилизация >= 30% (только она)',
      note: 'половина B — проверяем, что даёт память сверх утилизации',
      needs: [],
      fn: (s) => s.util_gpu >= 30,
    },
    {
      key: 'C',
      title: 'окно переднего плана во весь экран',
      note: 'вариант Q1-C интервью 013',
      needs: ['fs'],
      fn: (s) => s.fs === true,
    },
    {
      key: 'C+B',
      title: 'полный экран ИЛИ утилизация >= 30%',
      note: 'составное: полный экран ловит кино, утилизация — рендер в окне',
      needs: ['fs'],
      fn: (s) => s.fs === true || s.util_gpu >= 30,
    },
  ];
}

// Что журнал ФАКТИЧЕСКИ содержит. Величина считается доступной, если хоть одна живая строка её
// принесла: контейнерный датчик не пишет свои сеансовые поля вовсе, а не пишет в них нули.
function journalProvides(states) {
  const have = new Set();
  for (const s of states) {
    if (s.stop) continue;
    if (s.has_fs) have.add('fs');
    if (s.has_fg) have.add('fg');
    if (s.has_idle) have.add('idle');
    if (s.has_procs) have.add('procs');
  }
  return have;
}

// ─── Разбор журнала ───────────────────────────────────────────────────────────────────────────

function readJournal(files) {
  const recs = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        recs.push(JSON.parse(t));
      } catch {
        console.error(`⚠️  битая строка в ${f}: ${t.slice(0, 80)}…`);
      }
    }
  }
  recs.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  return recs;
}

// Журнал пишет ПОЛНЫЙ список процессов только в стартовой строке, дальше — дельты. Восстанавливаем
// набор во времени: без этого правило A нечем прогнать вовсе.
function buildStates(recs) {
  const states = [];
  let procs = new Set();
  for (const r of recs) {
    if (r.ev === 'stop') {
      states.push({ ts: new Date(r.ts), stop: true, procs: new Set(procs) });
      continue;
    }
    if (Array.isArray(r.procs)) procs = new Set(r.procs);
    if (Array.isArray(r.added)) for (const p of r.added) procs.add(p);
    if (Array.isArray(r.removed)) for (const p of r.removed) procs.delete(p);
    states.push({
      ts: new Date(r.ts),
      ev: r.ev,
      src: r.src || 'host',
      mem_used: r.mem_used,
      util_gpu: r.util_gpu,
      fs: r.fs === true,
      fg: r.fg || '',
      klas: r.klas || '',
      idle_s: r.idle_s,
      procs: new Set(procs),
      // ИЗМЕРЕНО или ОТСУТСТВУЕТ — это разные вещи, и различить их можно только здесь, до того как
      // `fs: r.fs === true` превратит отсутствующее поле в честное на вид `false`.
      has_fs: r.fs !== undefined,
      has_fg: r.fg !== undefined,
      has_idle: r.idle_s !== undefined,
      has_procs: r.nproc !== undefined || Array.isArray(r.procs),
      stop: false,
    });
  }
  return states;
}

// Строка журнала действует ДО следующей строки — значит вклад каждой в эпизод измеряется временем,
// а не числом строк. Иначе одна секундная вспышка весила бы столько же, сколько час простоя.
function intervals(states, until) {
  const out = [];
  for (let i = 0; i < states.length; i++) {
    const s = states[i];
    if (s.stop) continue;
    const next = states[i + 1] ? states[i + 1].ts : until;
    out.push({ from: s.ts, to: next, s });
  }
  return out;
}

function overlapSec(aFrom, aTo, bFrom, bTo) {
  const from = Math.max(aFrom.getTime(), bFrom.getTime());
  const to = Math.min(aTo.getTime(), bTo.getTime());
  return to > from ? (to - from) / 1000 : 0;
}

function baselineMem(states) {
  // «Базовая» память рабочего стола — 10-й процентиль по журналу: медиана завышена, если владелец
  // полдня играл, а минимум занижен случайной ямой.
  const vals = states.filter((s) => !s.stop).map((s) => s.mem_used).sort((a, b) => a - b);
  if (!vals.length) return 0;
  return vals[Math.floor(vals.length * 0.1)];
}

// ─── Сводка журнала (критерии Ф1-1 и Ф1-4) ────────────────────────────────────────────────────

function summary(states, files) {
  const alive = states.filter((s) => !s.stop);
  if (!alive.length) {
    console.log('журнал пуст');
    return;
  }
  const first = alive[0].ts;
  const last = states[states.length - 1].ts;
  const hours = (last - first) / 3600e3;
  let bytes = 0;
  for (const f of files) bytes += fs.statSync(f).size;

  const provides = journalProvides(states);
  const sources = [...new Set(alive.map((s) => s.src))].join(', ');

  console.log('═══ СВОДКА ЖУРНАЛА ═══');
  console.log(`  источник: ${sources} · файлов: ${files.length} · строк: ${states.length} · объём: ${(bytes / 1024).toFixed(1)} КиБ`);
  console.log(`  окно: ${first.toISOString()} … ${last.toISOString()}  (${hours.toFixed(2)} ч)`);
  if (hours > 0) {
    const perDay = bytes / 1024 / (hours / 24);
    const verdict = perDay <= 1024 ? '✅' : '❌';
    console.log(`  Ф1-4 износ диска: ${(perDay / 1024).toFixed(3)} МиБ/сутки в этом темпе ${verdict} (порог 1 МиБ)`);
  }
  console.log(`  Ф1-1 покрытие: ${hours.toFixed(2)} ч ${hours >= 24 ? '✅' : '❌ (нужно ≥ 24 ч)'}`);

  // Разрыв = наблюдатель был мёртв: контрольная строка обязана приходить раз в 5 минут.
  const gaps = [];
  for (let i = 1; i < states.length; i++) {
    const gap = (states[i].ts - states[i - 1].ts) / 60e3;
    if (gap > 10) gaps.push({ from: states[i - 1].ts, to: states[i].ts, min: gap });
  }
  if (gaps.length) {
    console.log(`  ⚠️  разрывов > 10 мин: ${gaps.length} — в эти окна датчик не работал:`);
    for (const g of gaps.slice(0, 10)) {
      console.log(`      ${g.from.toISOString()} → ${g.to.toISOString()}  (${g.min.toFixed(0)} мин)`);
    }
  } else {
    console.log('  разрывов > 10 мин нет');
  }

  const base = baselineMem(alive);
  const maxMem = Math.max(...alive.map((s) => s.mem_used));
  const maxUtil = Math.max(...alive.map((s) => s.util_gpu));
  console.log(`  память: базовая ${base} МиБ · пик ${maxMem} МиБ · пик утилизации ${maxUtil}%`);
  if (provides.has('fs')) {
    const fsSec = intervals(alive, last).filter((i) => i.s.fs).reduce((a, i) => a + (i.to - i.from) / 1000, 0);
    console.log(`  во весь экран: ${(fsSec / 60).toFixed(1)} мин`);
  }
  // Молчать о недостающем нельзя: «0.0 мин во весь экран» и «полный экран не измеряется» —
  // разные утверждения, и второе меняет то, какие правила вообще участвуют в отборе.
  const missing = ['fs', 'fg', 'idle', 'procs'].filter((k) => !provides.has(k));
  if (missing.length) {
    console.log(`  ⚠️  НЕ ИЗМЕРЯЕТСЯ этим источником: ${missing.join(', ')} — сеансовые величины владельца`);
    console.log('      из контейнера недостижимы по устройству (см. шапку tools/gpu-manager.mjs).');
  }
  console.log('');
}

// Подсказка для разметки (Ш4): куски журнала, где карта явно работала. Это НЕ вердикт правила —
// это черновик эпизодов, который человек или агент подтверждает именами процессов.
function suggestEpisodes(states, last) {
  const ints = intervals(states.filter((s) => !s.stop), last);
  const hot = ints.filter((i) => i.s.util_gpu >= 30 || i.s.fs);
  if (!hot.length) {
    console.log('═══ КАНДИДАТЫ В ЭПИЗОДЫ ═══\n  нагрузки на карту в журнале не видно\n');
    return;
  }
  const merged = [];
  for (const h of hot) {
    const prev = merged[merged.length - 1];
    if (prev && (h.from - prev.to) / 1000 <= 120) {
      prev.to = h.to;
      prev.peakUtil = Math.max(prev.peakUtil, h.s.util_gpu);
      prev.peakMem = Math.max(prev.peakMem, h.s.mem_used);
      prev.fgs.add(h.s.fg);
    } else {
      merged.push({
        from: h.from, to: h.to, peakUtil: h.s.util_gpu, peakMem: h.s.mem_used, fgs: new Set([h.s.fg]),
      });
    }
  }
  console.log('═══ КАНДИДАТЫ В ЭПИЗОДЫ (черновик для Ш4) ═══');
  for (const m of merged) {
    const min = (m.to - m.from) / 60e3;
    // Имя окна — подсказка разметчику, а не факт правила. Когда источник его не даёт (контейнер),
    // столбец убирается совсем: пустое «окно:» читалось бы как «окна не было».
    const fgs = [...m.fgs].filter(Boolean).join(',');
    console.log(`  ${m.from.toISOString()} … ${m.to.toISOString()}  ${min.toFixed(1)} мин · ` +
      `пик util ${m.peakUtil}% · пик память ${m.peakMem} МиБ` + (fgs ? ` · окно: ${fgs}` : ''));
  }
  console.log('');
}

// ─── Прогон правил по размеченным эпизодам ────────────────────────────────────────────────────

function replay(states, episodes, busyFrac) {
  const alive = states.filter((s) => !s.stop);
  const last = states[states.length - 1].ts;
  const ints = intervals(alive, last);
  const allRules = makeRules(baselineMem(alive));
  const provides = journalProvides(alive);

  // Дисквалификация до счёта, а не после: правило без входа не «набирает ноль ошибок», оно
  // ВООБЩЕ не участвует. Иначе отбор возглавит то, что ничего не измеряло.
  const rules = allRules.filter((r) => r.needs.every((n) => provides.has(n)));
  const skipped = allRules.filter((r) => !r.needs.every((n) => provides.has(n)));

  console.log('═══ ПРОГОН ПРАВИЛ ПО ЭПИЗОДАМ ═══');
  console.log(`  порог вердикта: правило считается сказавшим «занято», если так было ≥ ${(busyFrac * 100).toFixed(0)}% времени эпизода`);
  if (skipped.length) {
    console.log('  ⛔ НЕ СУДИМ (в журнале нет их входа):');
    for (const r of skipped) {
      const lack = r.needs.filter((n) => !provides.has(n)).join(', ');
      console.log(`      ${r.key.padEnd(7)} ${r.title} — не хватает: ${lack}`);
    }
  }
  console.log('');
  if (!rules.length) {
    console.log('  ни одно правило не судимо по этому журналу — отбор невозможен.\n');
    return;
  }

  const score = new Map(rules.map((r) => [r.key, { falseAlarm: 0, missed: 0, ok: 0 }]));

  for (const ep of episodes) {
    const from = new Date(ep.from);
    const to = new Date(ep.to);
    const expectBusy = BUSY_CLASSES.has(ep.class);
    if (!expectBusy && !FREE_CLASSES.has(ep.class)) {
      console.log(`  ⚠️  эпизод с неизвестным классом «${ep.class}» пропущен`);
      continue;
    }
    const total = ints.reduce((a, i) => a + overlapSec(i.from, i.to, from, to), 0);
    console.log(`  ▸ ${ep.class.padEnd(11)} ${ep.from} … ${ep.to}  (${(total / 60).toFixed(1)} мин)` +
      (ep.note ? `  — ${ep.note}` : ''));
    if (total <= 0) {
      console.log('      ⚠️  журнал не покрывает этот эпизод');
      continue;
    }
    for (const r of rules) {
      let busy = 0;
      for (const i of ints) {
        if (r.fn(i.s)) busy += overlapSec(i.from, i.to, from, to);
      }
      const frac = busy / total;
      const said = frac >= busyFrac;
      let mark;
      const s = score.get(r.key);
      if (said === expectBusy) { mark = '✅ верно'; s.ok++; }
      else if (said && !expectBusy) { mark = '❌ ЛОЖНАЯ ТРЕВОГА'; s.falseAlarm++; }
      else { mark = '💀 ПРОПУСК (владелец ждал бы карту)'; s.missed++; }
      console.log(`      ${r.key.padEnd(7)} «занято» ${(frac * 100).toFixed(0).padStart(3)}% времени  ${mark}`);
    }
    console.log('');
  }

  console.log('═══ ИТОГ ПО ПРАВИЛАМ ═══');
  for (const r of rules) {
    const s = score.get(r.key);
    const clean = s.missed === 0 && s.falseAlarm === 0 ? '  ← кандидат' : '';
    console.log(`  ${r.key.padEnd(7)} верно ${s.ok} · ложных тревог ${s.falseAlarm} · ПРОПУСКОВ ${s.missed}${clean}`);
    console.log(`          ${r.title}  (${r.note})`);
  }
  console.log('\n  Ф1-3 выполнен, только если у выбранного правила НОЛЬ ложных тревог И НОЛЬ пропусков.');
}

// ─── Самопроверка: доказать, что прогон умеет назвать плохое правило плохим ────────────────────

function selftest() {
  // Синтетический журнал: полчаса простоя рабочего стола, затем полчаса игры во весь экран.
  const t0 = new Date('2026-08-16T20:00:00+03:00').getTime();
  const mk = (minAt, o) => ({ ts: new Date(t0 + minAt * 60e3).toISOString(), ev: 'change', ...o });
  const recs = [
    { ts: new Date(t0).toISOString(), ev: 'start', mem_used: 1000, util_gpu: 2, fs: false, fg: 'Code', klas: '', idle_s: 5, procs: ['dwm.exe', 'Code.exe', 'chrome.exe'] },
    mk(15, { mem_used: 1050, util_gpu: 3, fs: false, fg: 'Code', idle_s: 10 }),
    mk(30, { mem_used: 7000, util_gpu: 92, fs: true, fg: 'game', idle_s: 2, added: ['game.exe'] }),
    mk(45, { mem_used: 7200, util_gpu: 95, fs: true, fg: 'game', idle_s: 1 }),
    mk(60, { mem_used: 1020, util_gpu: 2, fs: false, fg: 'Code', idle_s: 3, removed: ['game.exe'] }),
  ];
  const states = buildStates(recs);
  const last = new Date(t0 + 60 * 60e3);
  const ints = intervals(states, last);
  const rules = makeRules(baselineMem(states));

  const episodes = [
    { from: new Date(t0).toISOString(), to: new Date(t0 + 30 * 60e3).toISOString(), class: 'work-nogpu' },
    { from: new Date(t0 + 30 * 60e3).toISOString(), to: new Date(t0 + 60 * 60e3).toISOString(), class: 'game' },
  ];

  // Контейнерный журнал: те же события, но БЕЗ сеансовых полей — так их пишет gpu-manager.
  const dockerRecs = [
    { ts: new Date(t0).toISOString(), ev: 'start', src: 'docker', mem_used: 1000, util_gpu: 2, klas: '' },
    mk(30, { src: 'docker', mem_used: 7000, util_gpu: 92 }),
    mk(60, { src: 'docker', mem_used: 1020, util_gpu: 2 }),
  ];
  const hostHas = journalProvides(states);
  const dockerHas = journalProvides(buildStates(dockerRecs));
  const dockerJudged = rules.filter((r) => r.needs.every((n) => dockerHas.has(n))).map((r) => r.key);

  const verdict = (ruleKey, ep) => {
    const r = rules.find((x) => x.key === ruleKey);
    const from = new Date(ep.from), to = new Date(ep.to);
    const total = ints.reduce((a, i) => a + overlapSec(i.from, i.to, from, to), 0);
    let busy = 0;
    for (const i of ints) if (r.fn(i.s)) busy += overlapSec(i.from, i.to, from, to);
    return total > 0 && busy / total >= 0.5;
  };

  const cases = [
    // Восстановление набора процессов из дельт — без него правило A нечем прогнать.
    ['набор процессов восстановлен из дельт', states[2].procs.has('game.exe') && !states[4].procs.has('game.exe')],
    // Правило A обязано ошибаться: на рабочем столе всегда есть чужие процессы.
    ['A даёт ложную тревогу на работе без GPU', verdict('A', episodes[0]) === true],
    ['A опознаёт игру (но ценой ложной тревоги)', verdict('A', episodes[1]) === true],
    // Правило B обязано быть чистым на обоих эпизодах.
    ['B молчит на работе без GPU', verdict('B', episodes[0]) === false],
    ['B опознаёт игру', verdict('B', episodes[1]) === true],
    // Полный экран ловит игру и молчит в окне.
    ['C молчит на работе без GPU', verdict('C', episodes[0]) === false],
    ['C опознаёт игру', verdict('C', episodes[1]) === true],
    // Вес по ВРЕМЕНИ, а не по числу строк: две строки простоя против двух строк игры дали бы 50/50.
    ['вклад строки измеряется временем', Math.abs(ints[2].to - ints[2].from) / 60e3 === 15],
    // Журнал хоста обязан отдавать все четыре сеансовые величины — иначе следующие два случая
    // доказывали бы отсутствие входа там, где его просто не записали.
    ['журнал хоста даёт fs/fg/idle/procs', ['fs', 'fg', 'idle', 'procs'].every((k) => hostHas.has(k))],
    // ГЛАВНОЕ: правило без входа обязано быть ДИСКВАЛИФИЦИРОВАНО, а не тихо посчитано «свободно».
    // Без этого C и C+B на контейнерном журнале показали бы НОЛЬ ложных тревог и возглавили отбор,
    // не измерив ничего.
    ['контейнерный журнал не даёт fs', !dockerHas.has('fs')],
    // Судимы ровно два — B и B-util. Дисквалифицированы ЧЕТЫРЕ: C и C+B (нет `fs`), A и A-lite
    // (нет списка процессов — из контейнера виден только собственный Xwayland прослойки WSL2).
    ['по контейнерному журналу судимы ровно 2 правила из 6', dockerJudged.length === 2],
    ['правила на fs дисквалифицированы, а не обнулены',
      !dockerJudged.includes('C') && !dockerJudged.includes('C+B')],
    ['правила на список процессов тоже дисквалифицированы',
      !dockerJudged.includes('A') && !dockerJudged.includes('A-lite')],
    // А правила, которым хватает одной карты, обязаны судиться и там.
    ['правила B и B-util судимы по контейнерному журналу',
      dockerJudged.includes('B') && dockerJudged.includes('B-util')],
  ];

  let bad = 0;
  console.log('самопроверка gpu-watch-replay:');
  for (const [name, ok] of cases) {
    console.log(`  ${ok ? '✅' : '❌'} ${name}`);
    if (!ok) bad++;
  }
  console.log(bad === 0 ? `\n✅ ${cases.length}/${cases.length}` : `\n❌ провалено ${bad} из ${cases.length}`);
  process.exit(bad === 0 ? 0 : 1);
}

// ─── main ─────────────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
if (argv.includes('--selftest')) selftest();

let epPath = path.join(LOG_DIR, 'episodes.json');
let busyFrac = 0.5;
// Наблюдателей ДВА, пока не закрыта фаза 1, и у каждого свой каталог. Смешивать их в одну ленту
// нельзя: разрывы считаются по одному источнику, а склейка показала бы сплошное покрытие там, где
// каждый датчик по отдельности умирал.
//   host   — tools/gpu-watch.ps1, сеанс владельца: единственный, кто видит «во весь экран»
//   docker — сервис gpu-manager внутри KLAS: только карта, зато без окон и внутри проекта
const SOURCES = { host: LOG_DIR, docker: path.join(LOG_DIR, 'docker') };
let source = 'host';
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--episodes') { epPath = argv[++i]; continue; }
  if (argv[i] === '--busy-frac') { busyFrac = Number(argv[++i]); continue; }
  if (argv[i] === '--source') { source = argv[++i]; continue; }
  files.push(argv[i]);
}
if (!files.length) {
  const dir = SOURCES[source];
  if (!dir) {
    console.error(`неизвестный источник «${source}» — допустимы: ${Object.keys(SOURCES).join(', ')}`);
    process.exit(1);
  }
  if (!fs.existsSync(dir)) {
    console.error(`нет каталога ${dir} — наблюдатель «${source}» ещё не запускался` +
      (source === 'host' ? ' (tools/gpu-watch.ps1)' : ' (docker compose up -d gpu-manager)'));
    process.exit(1);
  }
  for (const f of fs.readdirSync(dir).sort()) {
    if (f.endsWith('.jsonl')) files.push(path.join(dir, f));
  }
}
if (!files.length) {
  console.error('журналов не найдено');
  process.exit(1);
}

const recs = readJournal(files);
const states = buildStates(recs);
if (!states.length) {
  console.error('журнал пуст');
  process.exit(1);
}
summary(states, files);
suggestEpisodes(states, states[states.length - 1].ts);

if (fs.existsSync(epPath)) {
  const episodes = JSON.parse(fs.readFileSync(epPath, 'utf8'));
  replay(states, episodes, busyFrac);
} else {
  console.log(`═══ ПРОГОН ПРАВИЛ ═══\n  разметки эпизодов нет (${epPath}) — это шаг Ш4 плана 28.`);
  console.log('  Возьми кандидатов выше, подтверди классы и запиши массив:');
  console.log('  [{ "from": "…", "to": "…", "class": "game|render|video|idle|work-nogpu", "note": "…" }]');
}
