// ApiResponse — function-based success-response helpers.
//
// Envelope contract (locked in Phase 1):
//   {
//     success: true,                  // always present, boolean
//     message?: string,               // only on POST/PUT/PATCH/DELETE
//     data: any,                      // the payload (null on 204)
//     meta?: {                         // only on paginated lists
//       page, limit, total, totalPages, hasNextPage, hasPrevPage
//     }
//   }
//
// Use these in new endpoints. Existing controllers are unchanged.

export const sendSuccess = (res, data, { status = 200, message } = {}) => {
  const body = { success: true, data: data ?? null };
  if (message) body.message = message;
  return res.status(status).json(body);
};

export const sendCreated = (res, data, message) =>
  sendSuccess(res, data, { status: 201, message });

export const sendNoContent = (res) => res.status(204).end();

// Pagination helper. Caps `limit` at 100 silently. Out-of-range pages
// return an empty `data` array (not a 404) per the locked-in design.
//
//   const { data, meta } = paginate({ page, limit, total: await count() });
//   sendPaginated(res, data, meta);
//
// Or use the all-in-one form below.

export const buildPaginationMeta = ({ page, limit, total }) => {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const requestedLimit = parseInt(limit, 10) || 20;
  const safeLimit = Math.min(100, Math.max(1, requestedLimit));
  const totalPages = total === 0 ? 0 : Math.ceil(total / safeLimit);
  return {
    page: safePage,
    limit: safeLimit,
    total,
    totalPages,
    hasNextPage: safePage < totalPages,
    hasPrevPage: safePage > 1,
  };
};

export const sendPaginated = (res, data, meta) => {
  return res.status(200).json({
    success: true,
    data: data ?? [],
    meta,
  });
};
