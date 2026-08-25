// STEP 4b — APPLY the rescale in a single transaction.
//
// Pre-conditions (verified by the caller before this script runs):
//   1. scripts/migration-backup-2026-08-25.csv exists and contains
//      exactly the rows this script will UPDATE.
//   2. scripts/dryrun-rescale.csv contains the proposed new scores
//      that this script will write.
//   3. No row with updatedAt < CUTOVER has been added since the
//      backup (i.e. the DB still has exactly 135 legacy rows).
//
// This script:
//   - Re-verifies the legacy count is 135 (else aborts).
//   - Re-computes the per-user [userMin, userMax] band on the current
//     DB state, so the new score matches dryrun-rescale.csv exactly.
//   - Wraps the UPDATE in prisma.$transaction so a mid-batch failure
//     rolls everything back.
//   - Only touches `score`; never `updatedAt`.
//   - Leaves new-era rows (updatedAt >= CUTOVER) untouched.
import { prisma } from "../src/config/prisma.mjs";

const CUTOVER = new Date("2026-08-25T02:49:39.000Z");
const NEW_LO = 0.0;
const NEW_HI = 1.5;

const legacy = await prisma.behaviorScore.findMany({
  where: { updatedAt: { lt: CUTOVER } },
  select: { userId: true, tag: true, score: true },
});
console.log("LEGACY_ROWS_AT_START", legacy.length);
if (legacy.length !== 135) {
  console.error(
    `ABORT: expected 135 legacy rows, got ${legacy.length}. Backup is out of sync with DB.`,
  );
  await prisma.$disconnect();
  process.exit(3);
}

// Group by user
const byUser = new Map();
for (const r of legacy) {
  if (!byUser.has(r.userId)) byUser.set(r.userId, []);
  byUser.get(r.userId).push(r);
}

// Compute proposals
const updates = [];
for (const [userId, rows] of byUser) {
  const min = Math.min(...rows.map((r) => r.score));
  const max = Math.max(...rows.map((r) => r.score));
  const range = max - min;
  for (const r of rows) {
    let next;
    if (range === 0) {
      next = (NEW_LO + NEW_HI) / 2; // 0.75
    } else {
      next = NEW_LO + ((r.score - min) / range) * (NEW_HI - NEW_LO);
      next = Math.round(next * 10000) / 10000;
    }
    updates.push({ userId, tag: r.tag, oldScore: r.score, newScore: next });
  }
}
console.log("UPDATES_TO_RUN", updates.length);

// Sanity: spot-check the dry-run predictions for user b7e58b7d-…
const userCheck = updates.filter(
  (u) =>
    u.userId === "b7e58b7d-8472-4710-87bb-6d6f53bfce66" &&
    ["gaming", "category", "brand:Zte", "brand:Samsung"].includes(u.tag),
);
console.log("SPOTCHECK_BEFORE_UPDATE", userCheck);

// Apply via raw SQL so we can pin `updated_at` to the row's existing
// timestamp. The Prisma `BehaviorScore.updatedAt` field uses the
// `@updatedAt` directive, which the high-level client auto-bumps
// on every UPDATE — defeating our "never touch updatedAt" rule.
// `prisma.$executeRaw` bypasses that directive.
//
// We issue one UPDATE per row inside a single transaction so a
// mid-batch failure rolls back the whole batch.
console.log("STARTING_TRANSACTION");
let done = 0;
try {
  await prisma.$transaction(async (tx) => {
    for (const u of updates) {
      const r = await tx.$executeRaw`
        UPDATE behavior_scores
        SET score = ${u.newScore}::double precision,
            updated_at = behavior_scores.updated_at
        WHERE user_id = ${u.userId}::uuid
          AND tag = ${u.tag}
          AND updated_at < ${CUTOVER}::timestamptz
      `;
      if (r !== 1) {
        throw new Error(
          `ABORT: update affected ${r} row(s) for ${u.userId}/${u.tag} (expected 1).` +
          ` Row may have been re-touched between backup and UPDATE.`,
        );
      }
      done++;
      if (done % 25 === 0) console.log(`PROGRESS ${done}/${updates.length}`);
    }
  });
  console.log("TRANSACTION_OK", done);
} catch (e) {
  console.error("TRANSACTION_FAILED_AT", done, e);
  await prisma.$disconnect();
  process.exit(4);
}

// Verify
const afterLegacy = await prisma.behaviorScore.findMany({
  where: { updatedAt: { lt: CUTOVER } },
  select: { userId: true, tag: true, score: true },
});
console.log("LEGACY_ROWS_AFTER", afterLegacy.length);

const newEraAfter = await prisma.behaviorScore.findMany({
  where: { updatedAt: { gte: CUTOVER } },
  select: { tag: true, score: true },
});
console.log("NEW_ERA_ROWS_AFTER_COUNT", newEraAfter.length);

// Spot-check the same user after
const userAfter = afterLegacy.filter(
  (r) =>
    r.userId === "b7e58b7d-8472-4710-87bb-6d6f53bfce66" &&
    ["gaming", "category", "brand:Zte", "brand:Samsung"].includes(r.tag),
);
console.log("SPOTCHECK_AFTER_UPDATE", userAfter);

// Distribution summary
function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function summarize(name, scores) {
  console.log(
    `${name}: min=${Math.min(...scores).toFixed(4)} max=${Math.max(...scores).toFixed(4)} ` +
      `avg=${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4)} ` +
      `p10=${pct(scores, 10)?.toFixed(4)} p50=${pct(scores, 50)?.toFixed(4)} ` +
      `p90=${pct(scores, 90)?.toFixed(4)} p99=${pct(scores, 99)?.toFixed(4)}`,
  );
}
summarize("LEGACY_AFTER", afterLegacy.map((r) => r.score));
summarize("NEW_AFTER", newEraAfter.map((r) => r.score));

await prisma.$disconnect();