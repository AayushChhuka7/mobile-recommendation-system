// One-shot migration applier with deduplication. The migration's
// unique index on (user_id, phone_id, source, COALESCE(request_id, '…'))
// treats every legacy row with NULL request_id as belonging to the
// same bucket. With 21k rows and up to 355 duplicates per (user,
// phone), the index can't be created without first deduplicating
// legacy rows. Policy: keep the most recent row per group
// (MAX(shown_at)), since impressions are append-only.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const MIGRATION_PATH = resolve(
  process.cwd(),
  "prisma/migrations/20260813_recommendations_v2/migration.sql",
);

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set in the environment.");
  process.exit(1);
}

const sql = readFileSync(MIGRATION_PATH, "utf8");
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });

try {
  await c.connect();
  await c.query("BEGIN");

  // 1. Deduplicate legacy rows. The migration adds `source` as
  //    NOT NULL DEFAULT 'click', so all legacy rows will share
  //    source='click' once added. The dedup key is (user_id, phone_id)
  //    because that's what `recommendation_logs` writes per call —
  //    we don't have a finer-grained key on the legacy rows.
  //
  //    We keep the row with the highest shown_at per group. Within a
  //    tie we keep the highest log_id (insertion order surrogate).
  const before = await c.query("SELECT COUNT(*)::int AS n FROM recommendation_logs");
  console.log(`before: ${before.rows[0].n} rows`);

  const del = await c.query(`
    DELETE FROM recommendation_logs r
    USING recommendation_logs dup
    WHERE r.user_id = dup.user_id
      AND r.phone_id = dup.phone_id
      AND (
        r.shown_at < dup.shown_at
        OR (r.shown_at = dup.shown_at AND r.log_id < dup.log_id)
      )
  `);
  console.log(`deleted: ${del.rowCount} duplicate rows`);

  const after = await c.query("SELECT COUNT(*)::int AS n FROM recommendation_logs");
  console.log(`after: ${after.rows[0].n} rows`);

  // 2. Apply the migration. We're inside the same transaction so if
  //    anything fails (e.g. the unique index still can't be created)
  //    the dedup above is rolled back too.
  console.log("applying migration.sql…");
  await c.query(sql);
  console.log("migration.sql applied");

  await c.query("COMMIT");
  console.log("COMMIT — done.");
} catch (err) {
  await c.query("ROLLBACK").catch(() => {});
  console.error("FAILED:", err.message);
  console.error("detail:", err.detail);
  console.error("code:", err.code);
  console.error("constraint:", err.constraint);
  process.exitCode = 1;
} finally {
  await c.end();
}
