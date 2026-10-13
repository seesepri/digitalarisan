import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFileSync, cpSync, existsSync } from 'node:fs';
import { Pool } from 'pg';
import { assertDisposableTestDatabase } from './test-database-guard.mjs';

const url = process.env.TEST_DATABASE_URL; await assertDisposableTestDatabase(url);
const reserve = createServer(); await new Promise((resolve) => reserve.listen(0, '0.0.0.0', resolve)); const port = reserve.address().port; await new Promise((resolve) => reserve.close(resolve));
const base = `http://127.0.0.1:${port}`;
const appUrl = new URL(url); appUrl.username = 'digital_arisan_app'; appUrl.password = '';
execFileSync('psql', [url,'-v','ON_ERROR_STOP=1','-f','scripts/deploy/db-role-setup.sql'], { stdio: 'pipe' });
const env = { ...process.env, NODE_ENV: 'production', DATABASE_URL: appUrl.toString(), READ_DATABASE_URL: '', AUTH_SECRET: 'isolated-test-only-not-a-production-secret', BANK_PII_ENCRYPTION_KEY: Buffer.alloc(32,7).toString('base64'), APP_URL: 'https://local-http-test.invalid', CRON_SECRET: 'lab-only-cron-secret', METRICS_TOKEN: 'lab-only-metrics-token', PAYMENT_PROVIDER: 'unconfigured', PAYOUT_PROVIDER: 'unconfigured', SMS_PROVIDER: 'unconfigured', NEXT_TELEMETRY_DISABLED: '1', TRUST_PROXY: 'true', TRUST_PROXY_HOPS: '1', OTEL_ENABLED: 'false', DB_POOL_MIN: '0' };
for (const key of Object.keys(env)) if (/^(TWILIO_|MIDTRANS_|PAYOUT_PROVIDER_API_KEY|PAYMENT_PROVIDER_API_KEY)/.test(key)) delete env[key];
const pool = new Pool({ connectionString:url,max:1 });
const snapshot = async () => (await pool.query('SELECT id,available_balance::text,locked_balance::text,pending_balance::text FROM wallets ORDER BY id')).rows;
const before = await snapshot();
cpSync('.next/static','.next/standalone/.next/static',{recursive:true});
if(existsSync('public'))cpSync('public','.next/standalone/public',{recursive:true});
const child = spawn(process.execPath, ['.next/standalone/server.js'], { env: {...env,PORT:String(port),HOSTNAME:'0.0.0.0'}, stdio:['ignore','pipe','pipe'] });
let output = ''; child.stdout.on('data', (chunk) => { output+=String(chunk); }); child.stderr.on('data',(chunk) => { output+=String(chunk); });
const deadline = setTimeout(() => child.kill('SIGKILL'), 60_000);
try {
  await new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error(`HTTP test startup timed out: ${output}`)),30_000);
    const ready = (chunk) => { if (/Ready in/.test(String(chunk))) { clearTimeout(timer);resolve(); } };
    child.stdout.on('data',ready); child.stderr.on('data',ready); child.once('exit',(code) => { clearTimeout(timer);reject(new Error(`HTTP test server exited ${code}: ${output}`)); });
  });
  const call = (path, options={}) => fetch(new URL(path,base),{...options,signal:AbortSignal.timeout(5000)});
  const health = await call('/api/health'); assert.equal(health.status,200); const healthBody=await health.json();assert.equal(healthBody.ok,true);assert.equal(healthBody.service,'digital-arisan');
  assert.equal(health.headers.get('x-content-type-options'),'nosniff'); assert.ok(health.headers.get('x-request-id')); assert.ok(health.headers.get('traceparent')); assert.match(health.headers.get('content-security-policy')||'',/frame-ancestors 'self'/); assert.equal(health.headers.get('x-frame-options'),'SAMEORIGIN');
  assert.equal((await call('/api/ready')).status,200);
  assert.equal((await call('/api/v1/wallet')).status,401);
  assert.equal((await call('/api/v1/admin/users')).status,401);
  assert.ok([401,403].includes((await call('/api/v1/jobs/run',{method:'POST',headers:{authorization:'Bearer wrong-secret'}})).status));
  assert.ok([401,403].includes((await call('/api/metrics')).status));
  const metrics = await call('/api/metrics',{headers:{authorization:`Bearer ${env.METRICS_TOKEN}`}}); assert.equal(metrics.status,200); assert.match(await metrics.text(),/digital_arisan_up 1/);
  const invalidOrigin = await call('/api/v1/auth/logout',{method:'POST',headers:{origin:'https://forged.invalid'}}); assert.equal(invalidOrigin.status,403);
  const oversized = await call('/api/v1/auth/login',{method:'POST',headers:{origin:env.APP_URL,'content-type':'application/json'},body:JSON.stringify({noise:'x'.repeat(65000)})}); assert.equal(oversized.status,413);
  const missing = await call('/api/v1/admin/jobs/nonexistent/retry',{method:'POST',headers:{origin:env.APP_URL}}); assert.equal(missing.status,401,'real POST handler must exist and authorize, not silently return 404/405');
  console.log(execFileSync(process.execPath,['--import','tsx','--test','tests/e2e/http-smoke.test.ts'],{env:{...process.env,E2E_BASE_URL:base},encoding:'utf8'}));
  const load = execFileSync(process.execPath,['--test','tests/load/runtime-resilience.test.mjs'],{env:{...process.env,LOAD_TEST_URL:`${base}/api/health`,LOAD_TEST_CONCURRENCY:'20',LOAD_TEST_REQUESTS:'200'},encoding:'utf8'}); console.log(load);
  assert.deepEqual(await snapshot(),before,'HTTP read/security tests cannot alter wallet balances');
  const report={status:'PASS',syntheticEnvironment:true,framework:'Next production build',applicationRole:'digital_arisan_app (not owner)',checks:['health and database readiness','wallet/admin unauthenticated rejection','cron/metrics secrets required','valid metrics scrape','production CSP/framing and tracing headers','forged Origin rejected','oversized streamed JSON rejected','manual job POST handler actually exists','HTTP E2E smoke','200 health reads / concurrency 20','wallet balances unchanged'],providerSandbox:'BLOCKED',productionCapacity:'NOT_TESTED'};
  if(process.env.HTTP_TEST_OUTPUT_FILE)writeFileSync(process.env.HTTP_TEST_OUTPUT_FILE,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
} catch(error){ console.error(output.slice(-4000));throw error; }
finally {
  clearTimeout(deadline);child.kill('SIGTERM');
  if(child.exitCode===null)await new Promise((resolve)=>{const force=setTimeout(()=>{child.kill('SIGKILL');resolve();},5000);child.once('exit',()=>{clearTimeout(force);resolve();});});
  await pool.end();
}
