// STEP 4a — backup export for the 142 legacy rows.
// Writes userId, tag, score, updatedAt to a CSV the migration can be
// reverted from. Read-only on the DB (single SELECT).
import { prisma } from "../src/config/prisma.mjs";
import fs from "node:fs";

const CUTOVER = new Date("2026-08-25T02:49:39.000Z");
const OUT = "scripts/migration-backup-2026-08-25.csv";

const rows = await prisma.behaviorScore.findMany({
  where: { updatedAt: { lt: CUTOVER } },
  select: { userId: true, tag: true, score: true, updatedAt: true },
  orderBy: [{ userId: "asc" }, { tag: "asc" }],
});

const lines = ["userId,tag,score,updatedAt"];
for (const r of rows) {
  lines.push(
    `${r.userId},${JSON.stringify(r.tag)},${r.score},${r.updatedAt.toISOString()}`,
  );
}
fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");

console.log(`WROTE ${OUT}`);
console.log("ROW_COUNT", rows.length);

// Sanity: re-load the file and verify the count matches.
const re = fs.readFileSync(OUT, "utf8").split(/\r?\n/).filter(Boolean);
console.log("FILE_ROW_COUNT", re.length - 1); // minus header

// Distinct users
const users = new Set(rows.map((r) => r.userId));
console.log("DISTINCT_USERS", users.size);

await prisma.$disconnect();