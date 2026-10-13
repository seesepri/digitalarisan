import { Pool } from "pg";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: url, max: 2 });
try {
  const { rows } = await pool.query(`
    WITH chained AS (
      SELECT *, lag(entry_hash) OVER (ORDER BY sequence_no) AS expected_prev
      FROM audit_logs
    ), checked AS (
      SELECT *, encode(digest(
        coalesce(expected_prev, '') || '|' || id::text || '|' || coalesce(actor_id::text, '') || '|' || actor_type || '|' || action || '|' ||
        entity_type || '|' || coalesce(entity_id::text, '') || '|' || coalesce(old_value::text, '') || '|' || coalesce(new_value::text, '') || '|' ||
        coalesce(ip_address, '') || '|' || coalesce(user_agent, '') || '|' || created_at::text, 'sha256'
      ), 'hex') AS expected_hash
      FROM chained
    )
    SELECT count(*)::int AS broken FROM checked WHERE coalesce(prev_hash, '') <> coalesce(expected_prev, '') OR entry_hash <> expected_hash
  `);
  const broken = Number(rows[0]?.broken ?? 0);
  if (broken) throw new Error(`Audit integrity verification failed: ${broken} broken records`);
  const count = await pool.query("SELECT count(*)::int AS count FROM audit_logs");
  console.log(JSON.stringify({ valid: true, records: Number(count.rows[0]?.count ?? 0) }));
} finally { await pool.end(); }
