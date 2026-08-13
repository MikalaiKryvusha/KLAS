import { execFile } from 'child_process';
import { writeFileSync } from 'fs';

execFile(
  'f:\\KLAS\\llamacpp\\llama-server.exe',
  [
    '-m', 'F:\\LLMs\\LLAMACPP_MODELS\\Qwen2.5-Coder-14B-Instruct-Q5_K_M.gguf',
    '--port', '12345',
    '-ngl', '99',
    '-c', '20480',
    '--verbose'
  ],
  { timeout: 15000 },
  (error, stdout, stderr) => {
    writeFileSync('f:\\KLAS\\tools\\gpu-test-output.txt', `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}\n\nExit code: ${error?.exitCode}`);
    console.log('Test completed');
  }
);
