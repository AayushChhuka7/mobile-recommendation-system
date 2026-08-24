import api from "./api";

// Cached after the first successful fetch — `fallback-phones.json` lives
// in `public/` so Vite serves it at `/fallback-phones.json` and never
// changes between deploys. The fetch is intentionally lazy (only on BE
// failure) so the happy path doesn't pay the extra round-trip.
let fallbackCache = null;
const loadFallback = async () => {
  if (fallbackCache) return fallbackCache;
  try {
    const res = await fetch("/fallback-phones.json");
    if (!res.ok) return null;
    const json = await res.json();
    fallbackCache = Array.isArray(json?.data) ? json.data : null;
    return fallbackCache;
  } catch {
    return null;
  }
};

/**
 * Hit the backend's phone-catalog endpoint.
 *
 * Backend contract (see backend/src/routes/phoneRoutes.mjs +
 * backend/src/services/phoneService.mjs +
 * backend/src/serializers/phoneSerializer.mjs):
 *
 *   GET /api/phones
 *   Query params: brand, search, minPrice, maxPrice, minRam, minBattery,
 *                 minStorage, os, chipset, displayType, minRefreshRate,
 *                 minLensCount, year, has5G, hasNfc, hasOis,
 *                 hasHeadphoneJack, sort, page, limit
 *   200 → { success: true, data: formatPhoneListItem[], meta?: {...} }
 *
 * Returns the unwrapped phone list and pagination meta. The Dashboard
 * uses this for both the initial load and the "Retry catalog" path so
 * the parsing lives in one place.
 *
 * Falls back to a curated local snapshot (`public/fallback-phones.json`,
 * generated from project-root `hard.json`) when the BE call fails. This
 * keeps the dashboard usable while the dev DB is missing the
 * `phones.released_at` Prisma column — without it, every `/phones`
 * invocation 500s and the catalog section is blank. The snapshot mirrors
 * the catalog card shape the dashboard already renders against (id,
 * modelName, brand.name, cheapestVariant.{price,ram,storage},
 * keySpecs.{os,camera,battery}), so the UI is identical whether the data
 * came from the live BE or the local file.
 */
export async function getPhones(params = {}) {
  try {
    const res = await api.get("/phones", { params });
    return {
      phones: res?.data?.data ?? [],
      meta: res?.data?.meta ?? null,
    };
  } catch (err) {
    // Network/5xx → fall through to the local snapshot. Auth failures
    // (401) also land here but propagate normally: a logged-out user
    // can't read the fallback either, and we don't want to mask the
    // redirect-to-login flow.
    const fallback = await loadFallback();
    if (!fallback || fallback.length === 0) {
      // Re-throw the original error so the dashboard surfaces a real
      // message — better than an empty grid with no diagnostic.
      throw err;
    }
    return { phones: fallback, meta: null, fromFallback: true };
  }
}

/**
 * Hit the backend's phone-detail endpoint.
 *
 * Backend contract (see backend/src/routes/phoneRoutes.mjs +
 * backend/src/services/phoneService.mjs +
 * backend/src/serializers/phoneSerializer.mjs):
 *
 *   GET /api/phones/:id
 *   200 → { success: true, data: <formatPhoneDetail> }
 *   404 → { success: false, code: "RESOURCE_NOT_FOUND", ... }
 *
 * `formatPhoneDetail` shape:
 *   {
 *     id, modelName, imageUrl, antutuScore, isActive, source,
 *     brand: { id, name, logoUrl, website, country },
 *     specs: {
 *       network,  display,  platform,  camera,
 *       physical, battery,  metadata
 *     },
 *     variants: [{ id, ram, storage, storageType, price, isAvailable }],
 *     pricing: { cheapest, range: { min, max, currency } }
 *   }
 *
 * Each nested `specs.*` object has the same shape documented in
 * backend/docs/api.md under `formatPhoneDetail`. Missing fields come
 * back as `null`; missing nested objects are omitted.
 */
export async function getPhoneById(id) {
  if (!id) return null;
  const res = await api.get(`/phones/${id}`);
  // Backend success envelope: { success, data, message? }
  return res?.data?.data ?? null;
}

/**
 * Hit the backend's content-based "Related Phones" endpoint.
 *
 * Backend contract (see backend/src/routes/phoneRoutes.mjs +
 * backend/src/services/similarPhonesService.mjs +
 * ML Model/pipeline/serve.py `GET /similarity/similar`):
 *
 *   GET /api/phones/:id/similar?limit=12
 *   200 → { success: true, data: Array<formatPhoneListItem>, message? }
 *   400 → invalid id (length < 10)
 *
 * Sourced **exclusively** from the existing Content-Based ML cosine
 * similarity matrix (similarity_bundle.joblib). No collaborative
 * filtering, no hybrid, no persona, no popularity, no history.
 * Returns at most `limit` phones (default 12); the seed phone is
 * always excluded server-side.
 *
 * Returns an empty array on any soft-fail (FastAPI down, bundle
 * missing, seed not in bundle) — the FE detail page already has its
 * own error UI for the related-phones section.
 */
export async function getSimilarPhones(id, limit = 12) {
  if (!id) return [];
  const res = await api.get(`/phones/${id}/similar`, {
    params: { limit },
  });
  return res?.data?.data ?? [];
}
