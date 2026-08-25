// Diagnostic script — reads behavior_scores for the target user.
// Created only for this investigation; intended to be deleted afterward.
import { prisma } from "../src/config/prisma.mjs";

const userId = process.env.TARGET_USER_ID;
if (!userId) {
  console.error("Usage: TARGET_USER_ID=<uuid> node scripts/diag-behavior.mjs");
  process.exit(2);
}

const rows = await prisma.behaviorScore.findMany({
  where: { userId },
  orderBy: [{ score: "desc" }, { tag: "asc" }],
  select: { tag: true, score: true, updatedAt: true, reasons: true },
});

console.log("ROW_COUNT", rows.length);
for (const r of rows) {
  console.log(
    `${r.tag}\t${r.score}\t${r.updatedAt.toISOString()}`,
  );
}

// Affinity rows whose tag mentions iPhone 17
const iphone17 = rows.filter((r) => /iPhone\s*17/i.test(r.tag));
console.log("---IPHONE17_MATCHING---");
console.log("COUNT", iphone17.length);
for (const r of iphone17) {
  console.log(JSON.stringify(r, null, 2));
}

// All affinity: rows whose tag suffix does not look like a UUID
const affinityNonUuid = rows.filter((r) => {
  if (!r.tag.startsWith("affinity:")) return false;
  const id = r.tag.slice("affinity:".length);
  return !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
});
console.log("---AFFINITY_NON_UUID---");
console.log("COUNT", affinityNonUuid.length);
for (const r of affinityNonUuid) {
  console.log(JSON.stringify(r, null, 2));
}

// Phone lookup for affinity phoneIds
const affinityIds = Array.from(
  new Set(
    rows
      .map((r) => {
        if (!r.tag.startsWith("affinity:")) return null;
        const id = r.tag.slice("affinity:".length);
        return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
      })
      .filter(Boolean),
  ),
);
if (affinityIds.length) {
  const phones = await prisma.phones.findMany({
    where: { phoneId: { in: affinityIds } },
    select: { phoneId: true, modelName: true, brand: { select: { name: true } } },
  });
  console.log("---PHONE_RESOLUTION---");
  for (const p of phones) {
    console.log(p.phoneId, p.brand?.name, p.modelName);
  }
  const missing = affinityIds.filter(
    (id) => !phones.find((p) => p.phoneId === id),
  );
  console.log("---AFFINITY_IDS_NOT_IN_PHONES_TABLE---");
  for (const id of missing) console.log(id);
}

await prisma.$disconnect();