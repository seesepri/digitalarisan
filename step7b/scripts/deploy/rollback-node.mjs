import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const env = process.env;
if (!env.APP_ROLLBACK_COMMAND) throw new Error('APP_ROLLBACK_COMMAND is required; restore the previously approved Node.js release artifact with the process manager');
if (process.platform === 'win32') execFileSync('cmd.exe', ['/d', '/s', '/c', env.APP_ROLLBACK_COMMAND], { cwd: root, stdio: 'inherit', env });
else execFileSync('/bin/sh', ['-lc', env.APP_ROLLBACK_COMMAND], { cwd: root, stdio: 'inherit', env });
if (env.PRODUCTION_APP_URL) {
  const curl = process.platform === 'win32' ? 'powershell.exe' : 'curl';
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-Command', `Invoke-WebRequest -UseBasicParsing -Uri '${env.PRODUCTION_APP_URL}/api/ready' | Out-Null`]
    : ['-fsS', `${env.PRODUCTION_APP_URL}/api/ready`];
  execFileSync(curl, args, { cwd: root, stdio: 'inherit', env });
}
console.log('Node.js application rollback completed. Database rollback remains forward-only unless the approved DR restore procedure is invoked.');
