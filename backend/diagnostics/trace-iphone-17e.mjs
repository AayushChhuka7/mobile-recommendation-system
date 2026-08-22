// One-shot diagnostic: trace why "Apple iPhone 17e" is missing from
// auto-recommendations despite a high affinity score.
//
// Read-only. Touches the database, never writes.
//
// Run with: node diagnostics/trace-iphone-17e.mjs
//
// Prints, for the iPhone 17e row in the Phones table:
//   1. Whether the row exists and whether it is `isActive`
//   2. brand / modelName / priceEur / priceNpr / stockState / releasedAt
//   3. All BehaviorScore rows for the user that mention "iphone 17e",
//      "iphone air", or "affinity:" — to verify the phoneId in the
//      affinity row matches the current DB row.
//   4. A re-resolution by (Brand, Model) the way `resolvePhoneIds`
//      would do it, against the actual Prisma client.

import { prisma } from "../src/config/prisma.mjs";

const SEARCH_TERMS = ["iphone 17e", "iphone air", "iphone 17"];
const USER_ID = process.env.DIAG_USER_ID; // pass via env if you want to scope to a specific user

const log = (label, value) => {
  console.log(`\n=== ${label} ===`);
  if (value === null || value === undefined) {
    console.log("(null)");
    return;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
};

try {
  // ---- 1. Find every Phones row whose modelName matches one of the
  //         search terms, regardless of case. ----
  const phoneRows = await prisma.phones.findMany({
    where: {
      isActive: true,
      OR: SEARCH_TERMS.flatMap((t) => [
        { modelName: { equals: t, mode: "insensitive" } },
        { modelName: { contains: t, mode: "insensitive" } },
      ]),
    },
    include: {
      brand: { select: { name: true } },
      trend: { select: { trendScore: true } },
    },
  });
  log("Phones matching search terms", {
    count: phoneRows.length,
    rows: phoneRows.map((p) => ({
      phoneId: p.phoneId,
      brand: p.brand?.name,
      modelName: p.modelName,
      isActive: p.isActive,
      antutuScore: p.antutuScore,
      batteryMah: p.batteryMah,
      releasedAt: p.releasedAt,
      stockState: p.stockState,
      trendScore: p.trend?.trendScore,
      source: p.source,
    })),
  });

  // ---- 2. Repeat the exact query `resolvePhoneIds` runs. The BE
  //         matches on (brand equals, modelName equals). The brand
  //         comes from the ML output. ----
  const target = phoneRows.find((p) =>
    /iphone\s*17e/i.test(p.modelName) && /apple/i.test(p.brand?.name || ""),
  );
  if (target) {
    const exactMatch = await prisma.phones.findFirst({
      where: {
        isActive: true,
        brand: { name: { equals: target.brand.name, mode: "insensitive" } },
        modelName: { equals: target.modelName, mode: "insensitive" },
      },
      select: { phoneId: true, modelName: true, brand: { select: { name: true } } },
    });
    log("resolvePhoneIds-style lookup for iPhone 17e", exactMatch);
  } else {
    log("iPhone 17e row not present in Phones table", "skipped lookup");
  }

  // ---- 3. Pull every BehaviorScore row that references the 17e, the
  //         Air, or any `affinity:` tag. We need to see whether the
  //         `affinity:<phoneId>` row's phoneId still matches the DB
  //         row. If the phoneId drifted, the ranker will look up
  //         `affinity:<dead-uuid>` and find 0, falling back to
  //         NEUTRAL. ----
  if (USER_ID) {
    const behaviorRows = await prisma.behaviorScore.findMany({
      where: {
        userId: USER_ID,
        OR: [
          { tag: { contains: "iphone" } },
          { tag: { startsWith: "affinity:" } },
          { tag: { startsWith: "model:" } },
        ],
      },
      orderBy: { score: "desc" },
    });
    log(`BehaviorScore rows for user ${USER_ID}`, {
      count: behaviorRows.length,
      rows: behaviorRows.map((r) => ({ tag: r.tag, score: r.score })),
    });

    // Cross-check: does each `affinity:<uuid>` resolve to a current phone?
    const affinityTags = behaviorRows
      .filter((r) => r.tag.startsWith("affinity:"))
      .map((r) => r.tag.slice("affinity:".length));
    if (affinityTags.length > 0) {
      const phones = await prisma.phones.findMany({
        where: { phoneId: { in: affinityTags } },
        select: { phoneId: true, modelName: true, brand: { select: { name: true } } },
      });
      const found = new Set(phones.map((p) => p.phoneId));
      const orphan = affinityTags.filter((id) => !found.has(id));
      log("Affinity phoneId resolution", {
        totalAffinityTags: affinityTags.length,
        resolvedCount: affinityTags.length - orphan.length,
        orphanPhoneIds: orphan,
        resolvedSamples: phones.slice(0, 5).map((p) => ({
          phoneId: p.phoneId,
          modelName: p.modelName,
          brand: p.brand?.name,
        })),
      });
    }
  } else {
    console.log("\n(skipping BehaviorScore cross-check — set DIAG_USER_ID to enable)");
  }

  // ---- 4. The model hash the ranker uses. `hashModelName` in
  //         `behaviorAnalyzer.mjs` lower-cases + strips non-alphanum
  //         + takes the first 22 chars. ----
  if (target) {
    const fold = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 22);
    const expectedHash = fold(target.modelName);
    const expectedAffinityTag = `affinity:${target.phoneId}`;
    const expectedModelTag = `model:${expectedHash}`;
    log("Expected ranker tags for the iPhone 17e row", {
      phoneId: target.phoneId,
      modelHash: expectedHash,
      affinityTag: expectedAffinityTag,
      modelTag: expectedModelTag,
    });
  }
} catch (err) {
  console.error("Diagnostic failed:", err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect().catch(() => {});
}
