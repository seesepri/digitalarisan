import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const dir = join(root, 'drizzle');
const checksumFile = join(dir, 'MIGRATION_CHECKSUMS.sha256');
const lines = readFileSync(checksumFile, 'utf8').split(/\r?\n/).filter(Boolean);
const verifiedPaths = new Set();
for (const line of lines) {
  const [expected, file] = line.trim().split(/\s+/, 2);
  if (!/^drizzle\/\d{4}_[\w.-]+\.sql$/.test(file)) throw new Error(`invalid migration checksum path: ${file}`);
  if (verifiedPaths.has(file)) throw new Error(`duplicate migration checksum entry: ${file}`);
  verifiedPaths.add(file);
  const actual = createHash('sha256').update(readFileSync(join(root, file))).digest('hex');
  if (actual !== expected) throw new Error(`migration checksum mismatch: ${file}`);
}
const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const expectedPaths = files.map((file) => `drizzle/${file}`);
if (expectedPaths.length !== verifiedPaths.size || expectedPaths.some((file) => !verifiedPaths.has(file))) {
  throw new Error('migration checksum manifest must cover every active SQL migration exactly once');
}
const nums = files.map((f) => Number(f.slice(0, 4)));
const firstExpected = files[0] === '0000_baseline.sql' ? 0 : 1;
for (let i = 0; i < nums.length; i++) if (nums[i] !== firstExpected + i) throw new Error(`non-contiguous migrations: ${nums.join(',')}`);
console.log(`[security] checked ${files.length} migrations`);
