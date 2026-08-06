// similarPhonesService — Related Phones (content-based, single seed).
//
// Flow:
//   1. Look up the seed phone by `id` (UUID) via the existing
//      `phoneService.getPhoneById` so we get the canonical
//      `{brand.name, modelName}` pair (this is the key the FastAPI
//      bundle is indexed by).
//   2. Call FastAPI's `GET /similarity/similar` via the shared
//      `similarityClient.fetchSimilarPhones` wrapper. That endpoint
//      reads the pre-computed NxN cosine matrix in
//      similarity_bundle.joblib — no new algorithm, no collaborative
//      filtering, no fusion, no persona. Pure content-based item-item
//      lookup.
//   3. Map the returned `(brand, modelName)` rows back to actual
//      `phones` rows in the DB (using the same Prisma lookup pattern
//      as `recommendService.mjs` lines 235–268) so the controller can
//      run them through the existing `formatPhoneListItem` serializer
//      and produce the same shape the Dashboard's phone-card grid
//      already consumes.
//
// Soft-fail policy: any failure along the way (seed missing, FastAPI
// down, bundle not loaded, DB lookup empty) returns `[]`. The
// controller hides the Related Phones section when the array is empty.

import { prisma } from "../config/prisma.mjs";
import * as phoneService from "./phoneService.mjs";
import { fetchSimilarPhones } from "./similarityClient.mjs";

// Shared Prisma `include` shape used by every list-style phone
// query (`phoneService.getAllPhones`, `searchPhones`,
// `getPhonesByBrand`, `getFeaturedPhones`, …). Mirrored here so the
// similar-phones lookup produces rows in the exact shape
// `formatPhoneListItem` already knows how to serialize.
const phoneListInclude = {
  brand: {
    select: { brandId: true, name: true, logoUrl: true },
  },
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
};

const SIMILAR_DEFAULT_LIMIT = 12;
const SIMILAR_MAX_LIMIT = 50;

// Map a (brand, modelName) pair from the content-bundle back to a
// phones row. Mirrors the lookup in recommendService.mjs (lines
// 235–268): brand-name and model-name are matched with `contains`
// + `insensitive` so a small whitespace or casing difference between
// the bundle's CSV-derived strings and the DB still resolves. We try
// exact-match first (cheap), then fall back to contains.
async function findPhoneByBrandAndModel(brand, modelName) {
  if (!brand || !modelName) return null;

  const exact = await prisma.phones.findFirst({
    where: {
      isActive: true,
      modelName: { equals: modelName, mode: "insensitive" },
      brand: { name: { equals: brand, mode: "insensitive" } },
    },
    include: phoneListInclude,
  });
  if (exact) return exact;

  return prisma.phones.findFirst({
    where: {
      isActive: true,
      modelName: { contains: modelName, mode: "insensitive" },
      brand: { name: { contains: brand, mode: "insensitive" } },
    },
    include: phoneListInclude,
  });
}

export async function getSimilarPhones(phoneId, limit = SIMILAR_DEFAULT_LIMIT) {
  if (!phoneId) return [];
  const clampedLimit = Math.max(
    1,
    Math.min(SIMILAR_MAX_LIMIT, Number(limit) || SIMILAR_DEFAULT_LIMIT),
  );

  // 1. Resolve seed → { brand.name, modelName } via the existing
  //    Prisma helper. Reuses the same lookup the FE's "view phone"
  //    flow hits (see `getPhoneById` in phoneController.mjs).
  let seed;
  try {
    seed = await phoneService.getPhoneById(phoneId);
  } catch (_err) {
    // Phone not found / DB error — hide the section.
    return [];
  }
  if (!seed || !seed.brand?.name || !seed.modelName) return [];

  // 2. Ask FastAPI for the top-K most similar phones. Pure
  //    content-based cosine lookup against the pre-computed NxN
  //    matrix in similarity_bundle.joblib.
  const seedKey = { brand: seed.brand.name, modelName: seed.modelName };
  const ml = await fetchSimilarPhones({
    brand: seedKey.brand,
    modelName: seedKey.modelName,
    limit: clampedLimit,
  });
  if (!ml || !Array.isArray(ml.matches) || ml.matches.length === 0) {
    return [];
  }

  // 3. Map FastAPI's (brand, modelName) rows back to phones rows in
  //    the DB. Run all lookups in parallel; de-duplicate by phoneId
  //    (the bundle can occasionally have duplicate brand/model pairs
  //    across minor variants) and exclude the seed if it somehow
  //    sneaks back in (defensive — /similarity/similar already
  //    excludes it, but the lookup-by-name can resolve to a different
  //    variant of the same model).
  const lookupResults = await Promise.all(
    ml.matches.map((m) => findPhoneByBrandAndModel(m.brand, m.modelName)),
  );

  const seen = new Set();
  const phones = [];
  for (const phone of lookupResults) {
    if (!phone) continue;
    if (phone.phoneId === seed.phoneId) continue;
    if (seen.has(phone.phoneId)) continue;
    seen.add(phone.phoneId);
    phones.push(phone);
    if (phones.length >= clampedLimit) break;
  }

  return phones;
}