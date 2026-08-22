// enrichmentClient — single-owner of the "200 ML rows → DB rows" mapping.
//
// Fix #7 — replaces the legacy per-item `prisma.findFirst` loop with
// one batched lookup. Two phases:
//
//   1. resolvePhoneIds(pairs)  — given [{brand, modelName}, ...] returns
//      a Map<key, phoneId> using ONE findMany with a flat `OR` of
//      (brand equals, modelName equals). The legacy `contains` resolver
//      could match the wrong row (substring match on "iPhone 17" also
//      matches "iPhone 17 Pro"). The new resolver uses `equals` so a
//      miss is honest — if the ML side says "iPhone 17" we look up
//      exactly "iPhone 17" and let the dedupe later decide what to do
//      with collisions.
//
//   2. enrichPhonesById(ids)   — given a list of phoneIds returns
//      { phoneId -> full phone + brand + specs + variants + trend + stock }
//      via ONE findMany with the phoneId IN (...). The legacy version
//      of this was N=200 parallel `findFirst` calls.
//
// Both functions are best-effort: a read failure returns an empty
// Map and the caller falls back to the original 0-scored candidate
// shape (no crash, no 500).

import { prisma } from "../config/prisma.mjs";

const PHONE_INCLUDE = Object.freeze({
  brand: { select: { brandId: true, name: true, logoUrl: true } },
  specs: {
    select: {
      os: true,
      chipset: true,
      displaySize: true,
      displayType: true,
      refreshRate: true,
      mainCamera: true,
      batteryMah: true,
      supports5g: true,
      supportsNfc: true,
    },
  },
  variants: {
    where: { isAvailable: true },
    orderBy: { price: "asc" },
    select: {
      variantId: true,
      ramGb: true,
      storageGb: true,
      price: true,
      storageType: true,
    },
  },
  trend: { select: { trendScore: true } },
});

// Resolve a list of (brand, modelName) pairs to phoneIds in one query.
// Returns Map<"brand::model", phoneId> with the FIRST hit winning on
// collisions. Collisions are logged once per call so they show up in
// ops but do not fail the request — collisions in the catalog are a
// data-quality bug the dedupe pass later will smooth over.
export async function resolvePhoneIds(pairs) {
  const out = new Map();
  if (!Array.isArray(pairs) || pairs.length === 0) return out;

  const cleanPairs = pairs
    .map((p) => ({
      brand: typeof p?.brand === "string" ? p.brand.trim() : "",
      modelName: typeof p?.modelName === "string" ? p.modelName.trim() : "",
    }))
    .filter((p) => p.brand && p.modelName);

  if (cleanPairs.length === 0) return out;

  try {
    // Dedupe identical (brand, model) pairs so the OR is tight.
    const seen = new Set();
    const uniquePairs = [];
    for (const p of cleanPairs) {
      const k = `${p.brand.toLowerCase()}::${p.modelName.toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      uniquePairs.push(p);
    }

    const rows = await prisma.phones.findMany({
      where: {
        isActive: true,
        OR: uniquePairs.map((p) => ({
          brand: { name: { equals: p.brand, mode: "insensitive" } },
          modelName: { equals: p.modelName, mode: "insensitive" },
        })),
      },
      select: {
        phoneId: true,
        modelName: true,
        brand: { select: { name: true } },
      },
    });

    // Detect collisions: multiple catalog rows match the same
    // (brand, model). Last write wins on the map; we surface the count
    // to the warn log so the data team can deduplicate the catalog.
    const hitCount = new Map();
    for (const r of rows) {
      const k = `${r.brand.name.toLowerCase()}::${r.modelName.toLowerCase()}`;
      hitCount.set(k, (hitCount.get(k) || 0) + 1);
    }
    let collisionCount = 0;
    for (const [, c] of hitCount) {
      if (c > 1) collisionCount += 1;
    }
    if (collisionCount > 0) {
      console.warn(
        `[enrichment] ${collisionCount} (brand, model) collisions — first match wins`,
      );
    }

    for (const r of rows) {
      const k = `${r.brand.name.toLowerCase()}::${r.modelName.toLowerCase()}`;
      if (!out.has(k)) out.set(k, r.phoneId);
    }
    return out;
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[enrichment] resolvePhoneIds failed:",
        err?.message || err,
      );
    } else {
      console.error("[enrichment] resolvePhoneIds failed:", err);
    }
    return out;
  }
}

// Look up full phone rows by phoneId in a single batched query.
// Returns Map<phoneId, phone> so the caller can re-attach by id. On
// failure returns an empty Map — caller treats "no row" as a 0-score
// candidate, same as the legacy `findFirst` failure path.
export async function enrichPhonesById(phoneIds) {
  const out = new Map();
  if (!Array.isArray(phoneIds) || phoneIds.length === 0) return out;

  const ids = Array.from(
    new Set(phoneIds.filter((id) => typeof id === "string" && id.length > 0)),
  );
  if (ids.length === 0) return out;

  try {
    const rows = await prisma.phones.findMany({
      where: { phoneId: { in: ids } },
      include: PHONE_INCLUDE,
    });
    for (const row of rows) {
      out.set(row.phoneId, row);
    }
    return out;
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[enrichment] enrichPhonesById failed:",
        err?.message || err,
      );
    } else {
      console.error("[enrichment] enrichPhonesById failed:", err);
    }
    return out;
  }
}
