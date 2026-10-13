import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const env = process.env;
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', env });

if (!env.PRODUCTION_APP_URL) throw new Error('PRODUCTION_APP_URL is required');
if (!env.APP_RESTART_COMMAND) throw new Error('APP_RESTART_COMMAND is required; this must be the approved Node.js process-manager restart command');

run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
run('npm', ['run', 'security:check']);
run('npm', ['run', 'deploy:migration-preflight']);
run('npm', ['run', 'build']);

// APP_RESTART_COMMAND is intentionally supplied by the deployment platform so
// the application can run under systemd, NSSM, PM2, Windows Service, etc.
if (process.platform === 'win32') {
  execFileSync('cmd.exe', ['/d', '/s', '/c', env.APP_RESTART_COMMAND], { cwd: root, stdio: 'inherit', env });
} else {
  execFileSync('/bin/sh', ['-lc', env.APP_RESTART_COMMAND], { cwd: root, stdio: 'inherit', env });
}

for (let i = 0; i < 30; i++) {
  try {
    run(process.platform === 'win32' ? 'powershell.exe' : 'curl', process.platform === 'win32'
      ? ['-NoProfile', '-Command', `Invoke-WebRequest -UseBasicParsing -Uri '${env.PRODUCTION_APP_URL}/api/ready' | Out-Null`]
      : ['-fsS', `${env.PRODUCTION_APP_URL}/api/ready`]);
    console.log('Production readiness PASS.');
    process.exit(0);
  } catch {
    await new Promise((r) => setTimeout(r, 2000));
  }
}
throw new Error('New Node.js release did not become ready. Roll back using the approved process-manager release artifact.');
