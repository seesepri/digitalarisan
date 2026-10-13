const baseUrl = process.env.JOB_WORKER_URL || "http://app:3000/api/v1/jobs/run";
const intervalMs = Math.max(5000, Number(process.env.JOB_WORKER_INTERVAL_MS || 15000));
const cronSecretFile = process.env.CRON_SECRET_FILE;
let secret = process.env.CRON_SECRET;
if (!secret && cronSecretFile) secret = (await import('node:fs/promises')).readFile(cronSecretFile, 'utf8').then((v) => v.trim());
if (secret && typeof secret.then === 'function') secret = await secret;
if (!secret) throw new Error('CRON_SECRET or CRON_SECRET_FILE is required');
let stopping = false;
const stop = (signal) => { stopping = true; console.log(JSON.stringify({ level: 'INFO', event: 'job_worker_stopping', signal })); };
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));
while (!stopping) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(intervalMs - 1000, 5000));
  try {
    const response = await fetch(baseUrl, { method: 'POST', headers: { authorization: `Bearer ${secret}` }, signal: controller.signal });
    const body = await response.text();
    console.log(JSON.stringify({ level: response.ok ? 'INFO' : 'WARN', event: 'job_worker_tick', status: response.status, body: body.slice(0, 500) }));
  } catch (error) {
    console.error(JSON.stringify({ level: 'ERROR', event: 'job_worker_tick_failed', error: String(error) }));
  } finally { clearTimeout(timer); }
  if (!stopping) await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
