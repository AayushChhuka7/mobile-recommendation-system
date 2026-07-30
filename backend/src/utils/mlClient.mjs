// mlClient — shared FastAPI HTTP helper for the new application-layer
// recommendation services.
//
// Why a new helper when `recommendService.mjs` already has a private
// `mlFetch`? Two reasons:
//   1. Reuse — the new services (recommendation, comparison,
//      coldStart, candidateScoring, retraining, persona, explanation
//      helpers) all need to call FastAPI. Duplicating the fetch /
//      timeout / error-shape logic in each one is exactly what the
//      spec's "Avoid duplicated logic" rule warns against.
//   2. Upgradability — this module is the only place that knows how
//      to talk to FastAPI. Adding retry / circuit-breaker / tracing
//      later is a one-file change.
//
// The existing `recommendService.mjs` keeps its own private `mlFetch`
// for now; it's read-only on our end. Future migrations should fold
// the two together — out of scope here.

import { ML_BASE_URL } from "../config/ml.mjs";
import { badRequest, internal } from "./ApiError.mjs";

// ---- Defaults -------------------------------------------------------------
//
// Default timeout mirrors `recommendService.mjs`. The similarity
// client overrides this because it lazy-loads a 566 MB sklearn
// bundle on first hit.
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRIES = 0; // opt-in: callers pass `retries` explicitly.
const RETRY_BASE_DELAY_MS = 250;

// ---- Error message coercion ----------------------------------------------
//
// FastAPI replies come in many shapes:
//   - { message: "..." }
//   - { detail: "..." }
//   - { detail: [{ msg, loc, type }, ...] }    (pydantic 422)
//   - { error: "..." }
//   - a bare string
// Pull a one-liner out so thrown errors stay readable.
const describeError = (value) => {
  if (value == null) return "ML service error";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => {
        if (!entry) return null;
        if (typeof entry === "string") return entry;
        const where = Array.isArray(entry.loc) ? entry.loc.join(".") : null;
        const msg = typeof entry.msg === "string" ? entry.msg : null;
        return [where, msg].filter(Boolean).join(": ") || null;
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join("; ") : JSON.stringify(value);
  }
  if (typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    if (typeof value.detail === "string") return value.detail;
    if (typeof value.error === "string") return value.error;
    try {
      return JSON.stringify(value);
    } catch {
      return "ML service error";
    }
  }
  return String(value);
};

const safeErrorMessage = (err) => {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  const fromMessage = describeError(err.message);
  if (fromMessage !== "ML service error") return fromMessage;
  if (err.cause) {
    const fromCause = describeError(err.cause?.message ?? err.cause);
    if (fromCause) return fromCause;
  }
  return err.name || "unknown error";
};

// Sleep helper used between retries.
const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// ---------------------------------------------------------------------------
// Core fetch — single round-trip with optional retry + validation hook.
// ---------------------------------------------------------------------------

/**
 * Issue one HTTP request to the FastAPI ML service.
 *
 * @param {string} path         — path appended to `ML_BASE_URL`.
 * @param {object} [options]
 * @param {"GET"|"POST"} [options.method="GET"]
 * @param {*}        [options.body]    — JSON-serialisable payload (POST).
 * @param {number}   [options.timeoutMs=8000]
 * @param {number}   [options.retries=0]        — retry on network/5xx.
 * @param {AbortSignal} [options.signal]        — caller-provided abort.
 * @param {(data:any)=>string|null} [options.validate] — return error msg or null.
 * @returns {Promise<*>} parsed JSON body.
 */
export const mlFetch = async (
  path,
  {
    method = "GET",
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    signal,
    validate,
  } = {},
) => {
  let attempt = 0;
  let lastErr = null;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // If the caller passed their own signal, chain it so cancelling
    // their request also cancels ours.
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    try {
      const res = await fetch(`${ML_BASE_URL}${path}`, {
        method,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
        },
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        // 4xx — non-retryable. Surface a `badRequest` so the route can
        // present it to the user (esp. for 422 validation errors).
        if (res.status >= 400 && res.status < 500) {
          const msg = describeError(
            data?.message ?? data?.detail ?? data?.error,
          );
          throw badRequest(msg);
        }
        // 5xx — retryable.
        lastErr = internal(`ML service ${res.status}: ${describeError(data?.detail ?? data?.error)}`);
        // fall through to retry
      } else {
        if (typeof validate === "function") {
          const errMsg = validate(data);
          if (errMsg) throw badRequest(errMsg);
        }
        return data;
      }
    } catch (err) {
      // Already-shaped factory errors: rethrow verbatim.
      if (err && err.status) throw err;
      if (err && err.name === "AbortError") {
        lastErr = internal("ML service timed out");
      } else {
        lastErr = internal(`ML service unreachable (${safeErrorMessage(err)})`);
      }
    } finally {
      clearTimeout(timer);
    }

    attempt += 1;
    if (attempt <= retries) {
      // Exponential backoff capped at 2s — enough to absorb a brief
      // FastAPI blip without making the caller wait too long.
      const delay = Math.min(2000, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      await sleep(delay);
    }
  }

  throw lastErr || internal("ML service unreachable");
};

/** Convenience: POST JSON to FastAPI. */
export const mlPost = (path, body, opts = {}) =>
  mlFetch(path, { ...opts, method: "POST", body });

/** Convenience: GET from FastAPI. */
export const mlGet = (path, opts = {}) =>
  mlFetch(path, { ...opts, method: "GET" });

// ---------------------------------------------------------------------------
// Example usage
// ---------------------------------------------------------------------------
//
//   import { mlPost, mlGet } from "../utils/mlClient.mjs";
//
//   const { results } = await mlPost("/recommend", {
//     persona: "Gamer",
//     budget: { min: 0, max: 800 },
//     preferences: { gaming: 5 },
//   }, { timeoutMs: 15000, retries: 1 });
//
//   const health = await mlGet("/health");