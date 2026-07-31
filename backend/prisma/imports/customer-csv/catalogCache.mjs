// ---------------------------------------------------------------------------
// In-memory catalog cache.
//
// Loads every brand and phone into two Maps keyed by lowercased names so we
// can answer "does this brand/phone exist in the existing catalog?" without
// hammering the database row-by-row.
//
// IMPORTANT: this is a read-only cache. Per the import rules we MUST NOT
// create new brands or phones from the CSV. The cache is purely a lookup
// table for wishlist validation.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CatalogCache
 * @property {Map<string,string>} brandByName   lowercased name → brandId
 * @property {Map<string,string>} brandCanonical lowercased name → DB-canonical name
 * @property {Map<string,string>} phoneByKey    lowercased `${brand}::${model}` → phoneId
 * @property {Set<string>}        brandNames    lowercased brand names
 * @property {Set<string>}        phoneKeys     lowercased `${brand}::${model}` keys
 */

/**
 * Build a case-insensitive in-memory cache of all brands and phones.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @returns {Promise<CatalogCache>}
 */
export async function buildCatalogCache(prisma) {
  const [brands, phones] = await Promise.all([
    prisma.brands.findMany({ select: { brandId: true, name: true } }),
    prisma.phones.findMany({
      select: {
        phoneId: true,
        modelName: true,
        brand: { select: { name: true } },
      },
    }),
  ]);

  const brandByName = new Map();
  const brandCanonical = new Map();
  const brandNames = new Set();
  for (const b of brands) {
    const key = b.name.toLowerCase().trim();
    if (!key) continue;
    brandByName.set(key, b.brandId);
    brandCanonical.set(key, b.name);
    brandNames.add(key);
  }

  const phoneByKey = new Map();
  const phoneKeys = new Set();
  for (const p of phones) {
    const key = `${p.brand.name}::${p.modelName}`.toLowerCase().trim();
    if (!key) continue;
    phoneByKey.set(key, p.phoneId);
    phoneKeys.add(key);
  }

  return { brandByName, brandCanonical, phoneByKey, brandNames, phoneKeys };
}

/**
 * Look up a brand by case-insensitive name. Returns `null` when missing.
 * @param {CatalogCache} cache
 * @param {string} name
 */
export function findBrand(cache, name) {
  if (!name) return null;
  const key = String(name).toLowerCase().trim();
  return cache.brandByName.get(key) ?? null;
}

/**
 * Return the DB-canonical brand name for a CSV-provided name, or `null`
 * when not found. Use this to normalize brand strings before storing them
 * in `UserPreference.preferredBrands`.
 *
 * @param {CatalogCache} cache
 * @param {string} name
 * @returns {string|null}
 */
export function findBrandCanonical(cache, name) {
  if (!name) return null;
  const key = String(name).toLowerCase().trim();
  return cache.brandCanonical.get(key) ?? null;
}

/**
 * Look up a phone by `${brand}::${model}` (case-insensitive).
 * @param {CatalogCache} cache
 * @param {string} brandName
 * @param {string} modelName
 */
export function findPhone(cache, brandName, modelName) {
  if (!brandName || !modelName) return null;
  const key = `${brandName}::${modelName}`.toLowerCase().trim();
  return cache.phoneByKey.get(key) ?? null;
}
