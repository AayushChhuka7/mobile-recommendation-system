// Trigger a single live compare via the in-process services, mimicking
// exactly what the controller does. Logs every step so we can compare
// terminal output to the DB.
import { prisma } from "../src/config/prisma.mjs";
import { safeRecordCompareEvent } from "../src/services/profileService.mjs";

const userId = process.env.TARGET_USER_ID;
if (!userId) {
  console.error("Need TARGET_USER_ID");
  process.exit(2);
}

// Read the user's pair-counter state from the BE module if exposed;
// otherwise we rely on the [behaviorAnalyzer] log lines.
console.log("BEFORE: timestamp =", new Date().toISOString());

try {
  await safeRecordCompareEvent(userId, {
    modelNameA: "Apple iPhone 17",
    modelNameB: "Honor Play 8T",
  });
} catch (e) {
  console.error("safeRecordCompareEvent THREW:", e);
}

console.log("AFTER: timestamp =", new Date().toISOString());

// Verify in DB
const rows = await prisma.behaviorScore.findMany({
  where: { userId },
  orderBy: { updatedAt: "desc" },
  take: 5,
  select: { tag: true, score: true, updatedAt: true },
});
console.log("LATEST_5_ROWS");
for (const r of rows) console.log(JSON.stringify(r));

await prisma.$disconnect();