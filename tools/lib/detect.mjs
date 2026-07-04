// tools/lib/detect.mjs — детект железа и окружения для мастера (план 05). Только чтение, быстро.
// Возвращает структуру состояния системы: GPU/VRAM/драйвер, CUDA/ROCm, Docker/WSL2, Node/git/winget,
// свободное место, интернет. Windows-first (PowerShell/nvidia-smi/winget); безопасно падает в null.

import { execFileSync, execSync } from 'node:child_process';
import { statfsSync } from 'node:fs';

function out(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, ...opts }).trim();
  } catch { return null; }
}
function ps(script) {
  try {
    return execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 }).trim();
  } catch { return null; }
}

// GPU: сначала nvidia-smi (точно NVIDIA + VRAM + драйвер + CUDA), иначе видеоадаптеры через CIM.
function detectGpu() {
  const smi = out('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']);
  if (smi) {
    const [name, vramMiB, driver] = smi.split('\n')[0].split(',').map((s) => s.trim());
    // Версию CUDA выводит заголовок `nvidia-smi` (строка "CUDA Version: X.Y")
    const head = out('nvidia-smi', []) || '';
    const cuda = (head.match(/CUDA Version:\s*([\d.]+)/) || [])[1] || null;
    return { vendor: 'nvidia', name, vramGB: Math.round(Number(vramMiB) / 1024 * 10) / 10, driver, cuda, rocm: null };
  }
  // Не-NVIDIA: имя адаптера и объём памяти через CIM (AdapterRAM в байтах, урезан для >4ГБ, но ориентир)
  const cim = ps("Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name");
  if (cim) {
    const vendor = /amd|radeon/i.test(cim) ? 'amd' : /nvidia|geforce|rtx|gtx/i.test(cim) ? 'nvidia' : /intel/i.test(cim) ? 'intel' : 'unknown';
    return { vendor, name: cim, vramGB: null, driver: null, cuda: null, rocm: vendor === 'amd' ? (out('hipInfo', []) ? 'да' : null) : null };
  }
  return { vendor: 'none', name: null, vramGB: null, driver: null, cuda: null, rocm: null };
}

function versionOf(cmd, args = ['--version']) {
  const v = out(cmd, args);
  if (!v) return null;
  return (v.match(/[\d]+\.[\d]+(\.[\d]+)?/) || [v.split('\n')[0]])[0];
}

function freeDiskGB(path) {
  try { const s = statfsSync(path); return Math.round((s.bavail * s.bsize) / 1e9); }
  catch { return null; }
}

async function hasInternet() {
  try {
    const ctl = AbortSignal.timeout(6000);
    const r = await fetch('https://github.com', { method: 'HEAD', signal: ctl });
    return r.ok || r.status < 500;
  } catch { return false; }
}

// Полный снимок окружения. root — корень KLAS (для проверки места на нужном диске).
export async function detectEnvironment(root) {
  const gpu = detectGpu();
  const docker = versionOf('docker');
  const dockerRunning = docker ? out('docker', ['info', '--format', '{{.ServerVersion}}']) !== null : false;
  const wsl = out('wsl', ['--status']) !== null || out('wsl', ['-l', '-q']) !== null;
  return {
    gpu,
    docker: docker ? (dockerRunning ? `${docker} (запущен)` : `${docker} (не запущен)`) : null,
    dockerRunning,
    wsl,
    node: process.versions.node,
    git: versionOf('git'),
    winget: versionOf('winget'),
    freeDiskGB: freeDiskGB(root),
    internet: await hasInternet(),
  };
}
