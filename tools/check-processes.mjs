import { execSync } from 'child_process';

try {
  const out = execSync('netstat -ano | findstr "LISTENING"', { encoding: 'utf8', shell: 'cmd' });
  const lines = out.split('\n').filter(l => l.includes('llama') || l.includes('8080') || l.includes('580') || l.includes('3080'));
  console.log('=== Listening ports ===');
  lines.forEach(l => console.log(l));
} catch (e) {
  console.log('Error:', e.message);
}
