import { spawn } from 'child_process';
import { createWriteStream } from 'fs';

const logStream = createWriteStream('f:/KLAS/tools/cuda-test.log', { flags: 'w' });
logStream.write('Starting llama-server with CUDA test...\n');

const server = spawn('f:\\KLAS\\llamacpp\\llama-server.exe', [
  '-m', 'F:\\KLAS\\LLMs\\LLAMACPP_MODELS\\Qwen2.5-Coder-14B-Instruct-Q5_K_M.gguf',
  '--port', '12347',
  '-ngl', '99',
  '-c', '20480',
  '-ctk', 'q4_1',
  '-ctv', 'q4_1'
], {
  cwd: 'f:\\KLAS\\llamacpp',
  env: { ...process.env }
});

server.stdout.on('data', (data) => {
  logStream.write(`STDOUT: ${data}`);
  process.stdout.write(data);
});

server.stderr.on('data', (data) => {
  logStream.write(`STDERR: ${data}`);
  process.stderr.write(data);
});

server.on('close', (code) => {
  logStream.write(`\nProcess exited with code: ${code}\n`);
  logStream.end();
});

server.on('error', (err) => {
  logStream.write(`\nError: ${err}\n`);
});

// Wait 25 seconds then kill
setTimeout(() => {
  logStream.write('\nKilling server...\n');
  server.kill();
  logStream.write('Killed.\n');
  logStream.end();
  setTimeout(() => process.exit(0), 2000);
}, 25000);
