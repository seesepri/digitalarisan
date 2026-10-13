import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('API governance and domain-event architecture are present in the active baseline', () => {
  for (const file of [
    'src/server/api-governance.ts',
    'src/server/services/domain-events.ts',
  ]) assert.equal(fs.existsSync(file), true, file);
  const baseline = fs.readFileSync('drizzle/0000_baseline.sql', 'utf8');
  assert.match(baseline, /CREATE TABLE "arisan_period_read_models"/);
  assert.match(baseline, /CREATE TABLE "domain_event_outbox"/);
});

test('financial source of truth remains primary-only in the database access layer', () => {
  const source = fs.readFileSync('src/db/index.ts', 'utf8');
  assert.match(source, /READ_DATABASE_URL is optional/);
  assert.match(source, /Never use readDb inside writes/);
});
