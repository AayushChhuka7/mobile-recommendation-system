// Global error handler — Phase 1 rewrite.
//
// Pipeline:
//   1. shapeError(err) decides the final { status, code, message, details }.
//      - Prisma errors (P2002/P2025/P2003) are mapped here.
//      - Thrown factory errors (notFound, conflict, ...) carry their own
//        status/code/details; we trust those.
//      - Anything else falls through to 500 / INTERNAL_ERROR.
//   2. Stack is logged to stderr in dev only — never sent to the client.
//   3. The `details` block is included only when NODE_ENV !== "production".
//   4. Final envelope: { success: false, code, message, details? }.
//
// `asyncHandler` is re-exported from `utils/catchAsync.mjs` for
// back-compat with all existing import sites. New code should import
// `catchAsync` directly from `../utils/catchAsync.mjs`.

import { shapeError } from "../utils/ApiError.mjs";
import { catchAsync } from "../utils/catchAsync.mjs";

const isProd = () => process.env.NODE_ENV === "production";

export const errorHandler = (err, req, res, next) => {
  if (res.headersSent) {
    // Delegate to Express's default handler when the response is
    // already in flight. Otherwise we'd hang the socket.
    return next(err);
  }

  const shaped = shapeError(err);

  if (!isProd()) {
    // Log full stack + raw error so devs can debug; never leak to client.
    // eslint-disable-next-line no-console
    console.error("[errorHandler]", {
      path: req.originalUrl,
      method: req.method,
      code: shaped.code,
      status: shaped.status,
      message: shaped.message,
      stack: err && err.stack,
    });
  }

  const body = {
    success: false,
    code: shaped.code,
    message: shaped.message,
  };
  if (shaped.details) {
    body.details = shaped.details;
  }

  return res.status(shaped.status).json(body);
};

// Back-compat re-export. Every existing import site reads:
//   import { asyncHandler } from "../middleware/errorHandler.mjs";
// This keeps those imports working unchanged.
export const asyncHandler = catchAsync;
