// STEP 3 — DRY RUN ONLY. No writes.
// Computes the proposed new score for every legacy row under the
// per-user rank-preserving remap and prints a report. Touches only
// SELECT.
import { prisma } from "../src/config/prisma.mjs";
import fs from "node:fs";

const CUTOVER = new Date("2026-08-25T02:49:39.000Z");
const NEW_LO = 0.0;
const NEW_HI = 1.5;

const all = await prisma.behaviorScore.findMany({
  select: { userId: true, tag: true, score: true, updatedAt: true },
});
const legacy = all.filter((r) => r.updatedAt.getTime() < CUTOVER.getTime());

// Per-user min/max
const byUser = new Map();
for (const r of legacy) {
  const cur = byUser.get(r.userId) || [];
  cur.push(r);
  byUser.set(r.userId, cur);
}
for (const arr of byUser.values()) {
  arr.sort((a, b) => a.score - b.score);
}

const proposals = [];
const summary = {
  rowsAffected: 0,
  usersAffected: byUser.size,
  usersWithSingleRow: 0,
  rowsCollapsingToTied: 0,
  rowsAboveCap: 0,
};

const perUserResults = [];
for (const [userId, rows] of byUser) {
  const min = rows[0].score;
  const max = rows[rows.length - 1].score;
  const range = max - min;
  let singleRow = false;
  if (range === 0) {
    summary.usersWithSingleRow++;
    singleRow = true;
  }
  // Tied-value detection
  const byScore = new Map();
  for (const r of rows) byScore.set(r.score, (byScore.get(r.score) || 0) + 1);

  const mapped = rows.map((r) => {
    let next;
    if (range === 0) {
      next = (NEW_LO + NEW_HI) / 2; // 0.75
    } else {
      next = NEW_LO + ((r.score - min) / range) * (NEW_HI - NEW_LO);
      next = Math.round(next * 10000) / 10000;
    }
    if (next > NEW_HI + 0.0001) summary.rowsAboveCap++;
    return { ...r, newScore: next };
  });

  proposals.push(...mapped);
  summary.rowsAffected += mapped.length;

  perUserResults.push({
    userId,
    rowCount: rows.length,
    userMin: min,
    userMax: max,
    range,
    singleRow,
    topMapped: mapped.slice().sort((a, b) => b.newScore - a.newScore).slice(0, 5),
  });
}

// Tied-collapse detection: count rows whose newScore equals at least one other row's newScore for the same user.
const tiedByUser = new Map();
for (const p of proposals) {
  const cur = tiedByUser.get(p.userId) || new Map();
  cur.set(p.newScore, (cur.get(p.newScore) || 0) + 1);
  tiedByUser.set(p.userId, cur);
}
for (const [, m] of tiedByUser) {
  for (const [, n] of m) if (n >= 2) summary.rowsCollapsingToTied += n;
}

console.log("---SUMMARY---");
console.log(JSON.stringify(summary, null, 2));

console.log("---PER-USER_PREVIEW---");
for (const u of perUserResults) {
  console.log(`\nUSER ${u.userId} (rows=${u.rowCount} min=${u.userMin.toFixed(4)} max=${u.userMax.toFixed(4)} singleRow=${u.singleRow})`);
  for (const r of u.topMapped) {
    console.log(`  ${r.score.toFixed(4).padStart(8)} -> ${r.newScore.toFixed(4)}  ${r.tag}`);
  }
}

// Distribution of new vs old for legacy rows
function pct(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}
const oldScores = proposals.map((p) => p.score);
const newScores = proposals.map((p) => p.newScore);
function summarize(name, scores) {
  console.log(
    `${name}: min=${Math.min(...scores).toFixed(4)} max=${Math.max(...scores).toFixed(4)} ` +
      `avg=${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4)} ` +
      `p10=${pct(scores, 10)?.toFixed(4)} p50=${pct(scores, 50)?.toFixed(4)} ` +
      `p90=${pct(scores, 90)?.toFixed(4)} p99=${pct(scores, 99)?.toFixed(4)}`,
  );
}
console.log("\n---DIST_AFTER_DRY_RUN---");
summarize("OLD_LEGACY", oldScores);
summarize("NEW_LEGACY_PROPOSED", newScores);

// Spot-check known cases
console.log("\n---SPOT_CHECKS---");
const userId = "b7e58b7d-8472-4710-87bb-6d6f53bfce66";
const checks = [
  { tag: "gaming", expect: "user's top, should rescale to 1.5" },
  { tag: "category", expect: "user's #2" },
  { tag: "brand:apple", expect: "mid band — newer-era but check it isn't in legacy" },
  { tag: "affinity:1fd8a75f-f7ef-4203-a212-ccc5b3238897", expect: "iPhone 17 — NEW-era, should be untouched" },
  { tag: "brand:Zte", expect: "legacy high-magnitude" },
];
for (const c of checks) {
  const row = proposals.find((p) => p.userId === userId && p.tag === c.tag);
  if (!row) {
    console.log(`  (not in legacy proposals)  ${c.tag}  expect=${c.expect}`);
    continue;
  }
  console.log(`  ${row.score.toFixed(4)} -> ${row.newScore.toFixed(4)}  ${row.tag}  // ${c.expect}`);
}

// Comparison: new-era rows for the same user (should NOT be in proposals)
console.log("\n---NEW_ERA_ROWS_FOR_SAME_USER (untouched) ---");
const newerForUser = all.filter(
  (r) => r.userId === userId && r.updatedAt.getTime() >= CUTOVER.getTime(),
);
for (const r of newerForUser) {
  console.log(`  ${r.score.toFixed(4)}  ${r.tag}  (untouched, will remain ${r.score.toFixed(4)})`);
}

// CSV-style report of every legacy row → file (not DB)
const csv = ["userId,tag,oldScore,newScore,updatedAt"];
for (const p of proposals) {
  csv.push(`${p.userId},${JSON.stringify(p.tag)},${p.score},${p.newScore},${p.updatedAt.toISOString()}`);
}
fs.writeFileSync("scripts/dryrun-rescale.csv", csv.join("\n"), "utf8");
console.log(`\nCSV written: scripts/dryrun-rescale.csv  (${proposals.length} rows)`);

await prisma.$disconnect();