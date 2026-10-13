import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const env = process.env;
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', env });

if (!env.PRODUCTION_APPROVAL_REFERENCE) throw new Error('BLOCKED: an approved release reference covering provider certification, legacy findings, keys, roles and DR gates is required');
if (!env.PRODUCTION_APP_URL) throw new Error('PRODUCTION_APP_URL is required');
if (!env.APP_RESTART_COMMAND) throw new Error('APP_RESTART_COMMAND is required; this must be the approved Node.js process-manager restart command');

run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
run('npm', ['run', 'security:check']);
run('npm', ['run', 'deploy:migration-preflight']);
execFileSync(process.execPath, ['scripts/deploy/migration-state-check.mjs'], { cwd: root, stdio: 'inherit', env: {...env, REQUIRE_ALL_MIGRATIONS_APPLIED:'YES'} });
run(process.execPath, ['scripts/security/verify-database-integrity.mjs']);
run(process.execPath, ['scripts/security/verify-audit-integrity.mjs']);
run('npm', ['run', 'build']);
const runtimeEnv = {...env}; delete runtimeEnv.MIGRATION_DATABASE_URL;

// APP_RESTART_COMMAND is intentionally supplied by the deployment platform so
// the application can run under systemd, NSSM, PM2, Windows Service, etc.
if (process.platform === 'win32') {
  execFileSync('cmd.exe', ['/d', '/s', '/c', env.APP_RESTART_COMMAND], { cwd: root, stdio: 'inherit', env: runtimeEnv });
} else {
  execFileSync('/bin/sh', ['-lc', env.APP_RESTART_COMMAND], { cwd: root, stdio: 'inherit', env: runtimeEnv });
}

for (let i = 0; i < 30; i++) {
  try {
    run(process.platform === 'win32' ? 'powershell.exe' : 'curl', process.platform === 'win32'
      ? ['-NoProfile', '-Command', `Invoke-WebRequest -UseBasicParsing -Uri '${env.PRODUCTION_APP_URL}/api/ready' | Out-Null`]
      : ['-fsS', `${env.PRODUCTION_APP_URL}/api/ready`]);
    console.log('Application liveness/database connectivity PASS. Financial production readiness remains subject to the separately approved evidence gates; HTTP health is not certification.');
    process.exit(0);
  } catch {
    await new Promise((r) => setTimeout(r, 2000));
  }
}
throw new Error('New Node.js release did not become ready. Roll back using the approved process-manager release artifact.');
