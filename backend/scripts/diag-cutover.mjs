// Read-only diagnostic: derive the cutover timestamp + produce
// distribution stats for the behavior_scores table split by era.
import { prisma } from "../src/config/prisma.mjs";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// 1. CUT-OVER TIMESTAMP
// ---------------------------------------------------------------------------
// behaviorConfig.mjs is the file whose edit changes the deltas. The
// lastWriteTime of that file on disk is the moment the BE *could*
// have started using new deltas — but only if the BE was actually
// restarted at or after that time. We've previously confirmed the BE
// process was started at 8:34 AM today (file was edited 8:28 AM). So
// the effective cutover in this environment is the LATER of:
//   (a) the file's lastWriteTime
//   (b) the BE process start time
// Anything `updatedAt < max(a, b)` is "legacy era" by definition.
const cfgPath = "src/config/behaviorConfig.mjs";
const stat = fs.statSync(cfgPath);
console.log("FILE_LAST_WRITE", stat.mtime.toISOString());

// ---------------------------------------------------------------------------
// 2. BE PROCESS START TIME
// ---------------------------------------------------------------------------
// PowerShell `Get-Process` reports local time. The BE pair (PIDs
// 15324 / 27752) shows StartTime = 2026-08-25 08:34:38-39 AM Nepal
// Standard Time (UTC+05:45), which is 02:49:38-39 UTC. We hardcode
// the verified UTC value here.
const beStartIso = "2026-08-25T02:49:39.000Z";
console.log("BE_PROCESS_START_UTC", beStartIso);

// Effective cutover = max of the two (file edit + BE start)
const fileMs = stat.mtime.getTime();
const beMs = new Date(beStartIso).getTime();
const cutMs = Math.max(fileMs, beMs);
const cutover = new Date(cutMs);
console.log("EFFECTIVE_CUTOVER", cutover.toISOString());

// ---------------------------------------------------------------------------
// 3. DISTRIBUTIONS
// ---------------------------------------------------------------------------
const all = await prisma.behaviorScore.findMany({
  select: { userId: true, tag: true, score: true, updatedAt: true },
});
console.log("TOTAL_ROWS", all.length);

function pct(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}
function summarize(name, rows) {
  if (rows.length === 0) {
    console.log(`${name}: EMPTY`);
    return;
  }
  const scores = rows.map((r) => r.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const neg = scores.filter((s) => s < 0);
  console.log(
    `${name}: count=${rows.length} min=${min.toFixed(4)} max=${max.toFixed(4)} avg=${avg.toFixed(4)} ` +
      `p10=${pct(scores, 10)?.toFixed(4)} p50=${pct(scores, 50)?.toFixed(4)} ` +
      `p90=${pct(scores, 90)?.toFixed(4)} p99=${pct(scores, 99)?.toFixed(4)} neg_count=${neg.length}`,
  );
}

const legacy = all.filter((r) => r.updatedAt.getTime() < cutMs);
const newer = all.filter((r) => r.updatedAt.getTime() >= cutMs);
summarize("LEGACY", legacy);
summarize("NEW", newer);

// Per-user breakdown of legacy rows
const legacyByUser = new Map();
for (const r of legacy) {
  legacyByUser.set(r.userId, (legacyByUser.get(r.userId) || 0) + 1);
}
console.log("LEGACY_USERS_COUNT", legacyByUser.size);
console.log("LEGACY_USER_HISTOGRAM_BUCKETS",
  JSON.stringify(
    Array.from(legacyByUser.entries()).reduce((acc, [, n]) => {
      const b = n < 5 ? "<5" : n < 20 ? "5-19" : n < 50 ? "20-49" : "50+";
      acc[b] = (acc[b] || 0) + 1;
      return acc;
    }, {}),
  ),
);

// Distribution of "score per legacy row" against the new era's plausible
// range. Print a histogram of legacy rows in score bands.
function hist(name, rows) {
  const bands = { "<0": 0, "0-0.5": 0, "0.5-1": 0, "1-1.5": 0, "1.5-2": 0, "2-3": 0, "3-4": 0, ">=4": 0 };
  for (const r of rows) {
    const s = r.score;
    if (s < 0) bands["<0"]++;
    else if (s < 0.5) bands["0-0.5"]++;
    else if (s < 1) bands["0.5-1"]++;
    else if (s < 1.5) bands["1-1.5"]++;
    else if (s < 2) bands["1.5-2"]++;
    else if (s < 3) bands["2-3"]++;
    else if (s < 4) bands["3-4"]++;
    else bands[">=4"]++;
  }
  console.log(`${name}_HIST`, JSON.stringify(bands));
}
hist("LEGACY", legacy);
hist("NEW", newer);

// Cross-era per-user: top-3 legacy scores by user, side by side
const topByUser = new Map();
for (const r of legacy) {
  const cur = topByUser.get(r.userId) || [];
  cur.push(r);
  if (cur.length > 5) cur.sort((a, b) => b.score - a.score).length = 5;
  topByUser.set(r.userId, cur);
}
const examples = Array.from(topByUser.entries()).slice(0, 3);
for (const [uid, rows] of examples) {
  console.log(`USER_TOP5_LEGACY ${uid}`);
  for (const r of rows) {
    console.log(`  ${r.score.toFixed(4)}  ${r.tag}  ${r.updatedAt.toISOString()}`);
  }
}

await prisma.$disconnect();