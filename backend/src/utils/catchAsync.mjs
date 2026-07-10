// catchAsync — wrap an async route handler so any thrown error is
// forwarded to the global error handler via `next(error)`.
//
// This is the same shape as the original `asyncHandler` in
// `src/middleware/errorHandler.mjs`. It is re-exported from there
// for back-compat with existing import sites; new code should import
// it from this file directly.

export const catchAsync = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
