// One-off diagnostic. Reads the last 10 compare events for any user
// and the user's BehaviorScore rows for `affinity:*`, `model:*`, and
// `brand:*` tags. Run from the backend/ directory:
//   node diagnostics/probe-compare.mjs
import { prisma } from "../src/config/prisma.mjs";

async function main() {
  console.log("=== last 10 compare events (with payload->>'pairKey') ===");
  const rows = await prisma.$queryRaw`
    SELECT event_id, user_id, phone_id, payload, payload->>'pairKey' AS pair_key,
           created_at
    FROM events
    WHERE event_type = 'compare'
    ORDER BY created_at DESC
    LIMIT 10
  `;
  for (const r of rows) {
    console.log({
      event_id: r.event_id,
      user_id: r.user_id,
      phone_id: r.phone_id,
      pair_key: r.pair_key,
      created_at: r.created_at,
      payload: r.payload,
    });
  }

  console.log("\n=== distinct pairKey count via $queryRaw ===");
  const distinctRows = await prisma.$queryRaw`
    SELECT DISTINCT payload->>'pairKey' AS pair_key
    FROM events
    WHERE event_type = 'compare'
      AND payload ? 'pairKey'
      AND payload->>'pairKey' IS NOT NULL
  `;
  console.log("count:", distinctRows.length);
  console.log("rows:", distinctRows);

  console.log("\n=== BehaviorScore rows for tag like affinity/model/brand ===");
  const scoreRows = await prisma.$queryRaw`
    SELECT user_id, tag, score, updated_at
    FROM behavior_scores
    WHERE tag LIKE 'affinity:%'
       OR tag LIKE 'model:%'
       OR tag LIKE 'brand:%'
    ORDER BY updated_at DESC
    LIMIT 30
  `;
  for (const r of scoreRows) {
    console.log({
      user_id: r.user_id,
      tag: r.tag,
      score: Number(r.score).toFixed(3),
      updated_at: r.updated_at,
    });
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("diagnostic failed:", err);
  process.exit(1);
});
