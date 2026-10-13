import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMigrationFiles } from './verify-migrations.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const url=process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if(!url)throw new Error('Migration-owner database URL is required');
if(process.env.ALLOW_SCHEMA_MIGRATION_APPLY!=='YES'||process.env.FINANCIAL_WORKERS_PAUSED!=='YES')throw new Error('BLOCKED: reviewed schema-migration approval and paused financial traffic/workers are required');
verifyMigrationFiles();
const env={...process.env,DATABASE_URL:url,MIGRATION_DATABASE_URL:url};
const run=(file,args=[])=>execFileSync(process.execPath,[file,...args],{cwd:root,env,encoding:'utf8'});
console.log(run('scripts/deploy/migration-state-check.mjs').trim());
const pool=new Pool({connectionString:url,max:1});
try{
  const {rows}=await pool.query("SELECT to_regclass('public.withdrawals') AS withdrawals");
  if(rows[0].withdrawals){
    const plan=JSON.parse(run('scripts/security/migrate-bank-pii.mjs'));
    if(plan.plaintextRows){
      if(process.env.ALLOW_BANK_PII_INITIAL_ENCRYPTION!=='YES')throw new Error('BLOCKED: initial plaintext encryption requires a separately rehearsed/approved BEFORE-0002 plan and original-key/backup preservation');
      console.log(run('scripts/security/migrate-bank-pii.mjs',['--apply']).trim());
    }
  }
  await migrate(drizzle(pool),{migrationsFolder:resolve(root,'drizzle')});
  console.log(run('scripts/deploy/migration-state-check.mjs').trim());
  console.log('Reviewed schema migrations completed. No withdrawal outcomes/refunds were repaired. NOT a production-readiness or zero-downtime certificate: keep financial traffic paused until preserved-data, constraint, provider and release gates pass.');
}finally{await pool.end();}
