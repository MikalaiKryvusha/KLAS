// tools/lib/resume.mjs — авто-продолжение мастера после перезагрузки (план 05, Ф2).
// Ставит ОДНОРАЗОВЫЙ запуск (HKCU RunOnce) — только с согласия пользователя: после следующего входа
// в Windows откроется консоль и мастер продолжится с сохранённого чекпоинта (.deploy-state.json).
// RunOnce Windows удаляет запись сам после срабатывания — чистить не нужно.

import { execFileSync } from 'node:child_process';

export function scheduleResumeAfterReboot(root, lang) {
  const cmd = `cmd /k "cd /d ${root} && node tools\\install.mjs --lang ${lang}"`;
  try {
    execFileSync('reg', [
      'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
      '/v', 'KLAS_Installer_Resume', '/t', 'REG_SZ', '/d', cmd, '/f',
    ], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}
