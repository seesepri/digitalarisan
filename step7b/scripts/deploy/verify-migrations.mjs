import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export function verifyMigrationFiles(root = projectRoot) {
  const dir = join(root, 'drizzle');
  const lines = readFileSync(join(dir, 'MIGRATION_CHECKSUMS.sha256'), 'utf8').split(/\r?\n/).filter(Boolean);
  const paths = new Map();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})\s+(drizzle\/\d{4}_[\w.-]+\.sql)$/.exec(line.trim());
    if (!match) throw new Error('invalid migration checksum entry');
    const [, expected, file] = match;
    if (paths.has(file)) throw new Error(`duplicate migration checksum entry: ${file}`);
    const actual = createHash('sha256').update(readFileSync(join(root, file))).digest('hex');
    if (actual !== expected) throw new Error(`migration checksum mismatch: ${file}`);
    paths.set(file, expected);
  }
  const files = readdirSync(dir).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort();
  if (!files.length || files.length !== paths.size || files.some((file) => !paths.has(`drizzle/${file}`))) {
    throw new Error('migration checksum manifest must cover every active SQL migration exactly once');
  }
  const first = files[0] === '0000_baseline.sql' ? 0 : 1;
  files.forEach((file, index) => { if (Number(file.slice(0, 4)) !== first + index) throw new Error('non-contiguous migrations'); });
  const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8'));
  if (journal.dialect !== 'postgresql' || !Array.isArray(journal.entries) || journal.entries.length !== files.length) {
    throw new Error('migration journal must cover every active SQL migration exactly once');
  }
  let lastWhen = 0;
  return journal.entries.map((entry, index) => {
    if (entry.idx !== index || `${entry.tag}.sql` !== files[index] || !Number.isSafeInteger(entry.when) || entry.when <= lastWhen) {
      throw new Error(`invalid migration journal order/tag/timestamp at index ${index}`);
    }
    lastWhen = entry.when;
    return { file: files[index], hash: paths.get(`drizzle/${files[index]}`), when: entry.when, tag: entry.tag };
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`[security] checked ${verifyMigrationFiles().length} migrations and journal entries`);
}
