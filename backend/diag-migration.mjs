// Focused diagnostic — get the EXACT server-side error for the
// unique index creation, and check the (user_id, phone_id) duplicate
// distribution that would cause it to fail once `source` exists.
import "dotenv/config";
import pg from "pg";

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const totalRows = await c.query(`SELECT COUNT(*)::int AS n FROM recommendation_logs`);
console.log("=== total recommendation_logs rows ===");
console.log(JSON.stringify(totalRows.rows, null, 2));

const dupes = await c.query(`
  SELECT user_id, phone_id, COUNT(*)::int AS c
  FROM recommendation_logs
  GROUP BY user_id, phone_id
  HAVING COUNT(*) > 1
  ORDER BY c DESC
  LIMIT 5
`);
console.log("\n=== (user_id, phone_id) duplicate groups ===");
console.log(JSON.stringify(dupes.rows, null, 2));

const maxDupes = await c.query(`
  SELECT MAX(c)::int AS max_dups
  FROM (
    SELECT COUNT(*) AS c
    FROM recommendation_logs
    GROUP BY user_id, phone_id
  ) t
`);
console.log("\n=== max duplicates for any (user, phone) pair ===");
console.log(JSON.stringify(maxDupes.rows, null, 2));

// Add the missing columns NOW (idempotent, in a transaction we control
// so we can roll back if anything goes wrong) and report the index
// failure exactly.
console.log("\n=== attempting ALTER TABLE recommendation_logs ===");
try {
  await c.query("BEGIN");
  await c.query(`
    ALTER TABLE recommendation_logs
      ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'click',
      ADD COLUMN IF NOT EXISTS request_id UUID,
      ADD COLUMN IF NOT EXISTS dwell_ms INT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS skipped BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS is_training_eligible BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS exploration_arm VARCHAR(40),
      ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ
  `);
  console.log("ALTER TABLE OK");
  console.log("=== attempting CREATE UNIQUE INDEX ===");
  await c.query(`
    CREATE UNIQUE INDEX impression_unique_idx
      ON recommendation_logs (user_id, phone_id, source, COALESCE(request_id, '00000000-0000-0000-0000-000000000000'::uuid))
  `);
  console.log("INDEX OK");
  await c.query("COMMIT");
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  console.log("FAILED");
  console.log("message:", e.message);
  console.log("code:", e.code);
  console.log("detail:", e.detail);
  console.log("hint:", e.hint);
  console.log("where:", e.where);
  console.log("table:", e.table);
  console.log("constraint:", e.constraint);
}

await c.end();
