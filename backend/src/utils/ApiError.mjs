// ApiError — function-based error factories.
//
// Design notes:
// - No classes. Each helper returns a plain `Error` with `status`, `code`,
//   and `details` attached as own properties. The global `errorHandler`
//   reads those three properties to build the response.
// - Callers throw the result: `throw notFound("User not found")`.
// - `prismaErrorMap(err)` converts a raw Prisma error into a shaped
//   error WITHOUT throwing — the caller (errorHandler) decides whether
//   to use the result or fall through.
//
// Code registry (locked in Phase 1):
//   AUTH_NOT_AUTHENTICATED   401
//   AUTH_INVALID_CREDENTIALS 401
//   AUTH_ACCOUNT_DEACTIVATED 403
//   AUTH_FORBIDDEN_ROLE      403
//   VALIDATION_INVALID_INPUT 400
//   OTP_INVALID              400
//   RESOURCE_NOT_FOUND       404
//   DUPLICATE_ENTRY          409
//   RECORD_NOT_FOUND         404
//   FOREIGN_KEY_FAILURE      400
//   INTERNAL_ERROR           500

const isProd = () => process.env.NODE_ENV === "production";

const buildError = (status, code, message, details) => {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  if (details && !isProd()) {
    err.details = details;
  }
  return err;
};

// ---- Domain factories ----

export const notFound = (message = "Resource not found", details) =>
  buildError(404, "RESOURCE_NOT_FOUND", message, details);

export const conflict = (message = "Resource already exists", details) =>
  buildError(409, "DUPLICATE_ENTRY", message, details);

export const badRequest = (message = "Bad request", details) =>
  buildError(400, "VALIDATION_INVALID_INPUT", message, details);

export const unauthorized = (message = "Not authenticated", details) =>
  buildError(401, "AUTH_NOT_AUTHENTICATED", message, details);

export const forbidden = (message = "Forbidden", details) =>
  buildError(403, "AUTH_FORBIDDEN_ROLE", message, details);

export const accountDeactivated = (message = "Account is deactivated", details) =>
  buildError(403, "AUTH_ACCOUNT_DEACTIVATED", message, details);

export const invalidCredentials = (message = "Invalid credentials", details) =>
  buildError(401, "AUTH_INVALID_CREDENTIALS", message, details);

export const otpInvalid = (message = "Invalid OTP", details) =>
  buildError(400, "OTP_INVALID", message, details);

export const internal = (message = "Internal server error", details) =>
  buildError(500, "INTERNAL_ERROR", message, details);

// ---- Prisma error mapping ----
//
// Returns `{ status, code, message, details }` if the error is a known
// Prisma error code; returns `null` otherwise so the caller can
// fall through to the generic INTERNAL_ERROR path.

const PRISMA_CODES = {
  P2002: {
    status: 409,
    code: "DUPLICATE_ENTRY",
    message: "A record with this value already exists",
  },
  P2025: {
    status: 404,
    code: "RECORD_NOT_FOUND",
    message: "Record not found",
  },
  P2003: {
    status: 400,
    code: "FOREIGN_KEY_FAILURE",
    message: "Foreign key constraint failed",
  },
};

export const prismaErrorMap = (err) => {
  if (!err || typeof err.code !== "string") return null;
  const mapped = PRISMA_CODES[err.code];
  if (!mapped) return null;

  const details = {};
  if (err.code === "P2002" && err.meta && err.meta.target) {
    // Prisma exposes `target` as the field name(s) hit by the unique
    // constraint. Normalize to a string for the FE.
    const target = err.meta.target;
    details.field = Array.isArray(target) ? target.join(",") : String(target);
  }
  details.prismaCode = err.code;

  return {
    status: mapped.status,
    code: mapped.code,
    message: mapped.message,
    details,
  };
};

// ---- Public helper used by the errorHandler ----
//
// `shapeError(err)` returns the final `{ status, code, message, details }`
// shape for any error. Order:
//   1. If it looks like a Prisma error, use the mapper.
//   2. If `err.status` / `err.code` are set (a thrown factory error),
//      trust them and only add `details` in dev.
//   3. Fallback: 500 / INTERNAL_ERROR with `err.message` if present.

export const shapeError = (err) => {
  const prisma = prismaErrorMap(err);
  if (prisma) {
    if (isProd()) {
      const { details: _omit, ...rest } = prisma;
      return rest;
    }
    return prisma;
  }

  if (err && (err.status || err.code)) {
    return {
      status: err.status || 500,
      code: err.code || "INTERNAL_ERROR",
      message: err.message || "Internal server error",
      ...(isProd() ? {} : err.details ? { details: err.details } : {}),
    };
  }

  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: (err && err.message) || "Internal server error",
  };
};
