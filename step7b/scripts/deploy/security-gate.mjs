import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...options });

console.log('[security] migration numbering/checksums');
run(process.platform === 'win32' ? 'node' : 'sha256sum', process.platform === 'win32'
  ? ['scripts/deploy/verify-migrations.mjs']
  : ['--check', 'drizzle/MIGRATION_CHECKSUMS.sha256']);

if (process.platform !== 'win32') {
  // Python is retained for the existing migration policy check on Unix-like CI hosts.
  run('python3', ['-c', `from pathlib import Path; import re; files=sorted(Path('drizzle').glob('[0-9][0-9][0-9][0-9]_*.sql')); nums=[int(re.match(r'^(\\d+)_',p.name).group(1)) for p in files]; assert nums==list(range(1,len(nums)+1)), nums; print(f'checked {len(files)} migrations')`]);
}

console.log('[security] tracked secret-like files');
try {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  const bad = tracked.split(/\r?\n/).filter(Boolean).filter((p) => /(^|\/)(\.env$|\.env\.|.*\.(pem|key|p12|pfx))/.test(p) && !/\.example$/.test(p));
  if (bad.length) throw new Error(`tracked secret material detected: ${bad.join(', ')}`);
} catch (err) {
  if (err?.status !== 128 && err?.code !== 'ENOENT') throw err;
  console.warn('[security] WARNING: not a Git checkout; tracked-file secret scan skipped');
}

console.log('[security] dependency lock / reproducible Node.js build');
const lock = join(root, 'package-lock.json');
if (!existsSync(lock)) {
  console.error('ERROR: package-lock.json is required for production release integrity.');
  process.exit(1);
}
const lockText = readFileSync(lock, 'utf8');
const lockJson = JSON.parse(lockText);
if (lockJson.lockfileVersion !== 3) {
  console.error('ERROR: package-lock.json must use lockfileVersion 3.');
  process.exit(1);
}
run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
run('npm', ['audit', '--omit=dev', '--audit-level=high']);

console.log('[security] release artifact integrity');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.packageManager !== 'npm@10.9.2') {
  console.error(`ERROR: packageManager must remain pinned to npm@10.9.2 (found ${pkg.packageManager ?? 'missing'}).`);
  process.exit(1);
}
const digest = createHash('sha256').update(lockText).digest('hex');
console.log(`[security] package-lock.json SHA-256: ${digest}`);
console.log('[security] PASS — Docker is not required by this release gate.');
