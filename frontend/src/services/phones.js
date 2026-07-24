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
