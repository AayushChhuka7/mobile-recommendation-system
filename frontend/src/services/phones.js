import api from "./api";

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
