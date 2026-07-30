// retrainingService — admin-only ML model retraining + activation.
//
// The project maintains a single active model artifact (`model.pkl`
// on the FastAPI side). Per the user's clarification, we do NOT
// introduce a model version history / rollback path — the service
// retrains, asks FastAPI to reload the artifact, and returns the
// training status. If validation fails, the existing model stays in
// place (no rollback because there is no prior version to roll
// back to).
//
// Workflow:
//   1. Admin calls triggerRetrain({ datasetVersion, hyperparameters }).
//      We POST to FastAPI's `/admin/retrain` endpoint, which returns a
//      jobId.
//   2. getStatus(jobId) polls FastAPI `/admin/retrain/{jobId}` until
//      the job is terminal (succeeded | failed) or the timeout fires.
//   3. On success, validateArtifact() pulls `/admin/model/metrics`
//      and applies thresholds:
//        accuracy   >= minAccuracy    (default 0.80)
//        recall     >= minRecall      (default 0.70)
//        latencyP95 <= maxLatencyMs   (default 250)
//      If any threshold fails, the job is treated as failed.
//   4. On validation pass, call FastAPI `/admin/model/reload` so the
//      new artifact becomes live in-process. FastAPI reports a
//      reloadedAt timestamp + a modelHash for audit.
//   5. On validation fail, return the failure; the existing model
//      remains active. (No prior version, so no rollback.)
//
// The service does NOT persist job state in the DB. State is held
// in-memory keyed by jobId for the polling window (TTL = 30 min).
// Job status beyond that window comes from FastAPI (it's the source
// of truth for the artifact).

import { mlGet, mlPost } from "../utils/mlClient.mjs";
import {
  invalidateOnModelVersionChange,
  setInvalidator,
  getCacheStats,
} from "./candidateScoringService.mjs";
import { badRequest, internal } from "../utils/ApiError.mjs";

// ---- Tunables ------------------------------------------------------------

const DEFAULT_MIN_ACCURACY = 0.8;
const DEFAULT_MIN_RECALL = 0.7;
const DEFAULT_MAX_LATENCY_MS = 250;

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

const JOB_TTL_MS = 30 * 60 * 1000;

// ---- In-memory job cache -------------------------------------------------

// jobId → { status, progress, startedAt, finishedAt, error,
//           modelVersion, reloadedAt, modelHash, history[] }
// The "live" view of a job. Cleared after JOB_TTL_MS or on terminal
// status lookup. Survives a process restart? No — by design; this
// is a coordination cache, not a source of truth.
const _jobs = new Map();

const setJob = (jobId, patch) => {
  const prev = _jobs.get(jobId) || {
    jobId,
    status: "queued",
    progress: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    modelVersion: null,
    reloadedAt: null,
    modelHash: null,
    history: [],
  };
  const next = { ...prev, ...patch };
  _jobs.set(jobId, next);
  return next;
};

const getJob = (jobId) => _jobs.get(jobId) || null;

const pruneOldJobs = () => {
  const now = Date.now();
  for (const [jobId, job] of _jobs.entries()) {
    if (!job.finishedAt) continue;
    if (now - new Date(job.finishedAt).getTime() > JOB_TTL_MS) {
      _jobs.delete(jobId);
    }
  }
};

// ---- Wire invalidation ---------------------------------------------------

// Register a callback so retraining invalidates the candidate
// scoring cache. Idempotent — multiple registrations are deduped by
// Set semantics on the invalidator list.
setInvalidator(({ reason }) => {
  if (reason === "model-version") {
    // The cache was already cleared by `invalidateOnModelVersionChange`
    // — this hook just exists for downstream observers (metrics,
    // logs). Nothing else to do here.
  }
});

// ---- Helpers -------------------------------------------------------------

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Coerce FastAPI's `progress` to a number in [0, 1]. Sometimes
// servers report percent (0..100), sometimes a fraction.
const normaliseProgress = (raw) => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return Math.min(1, n / 100);
  return n;
};

// Pure: did the metrics block pass the thresholds?
const passesThreshold = (metrics, thresholds) => {
  const acc = Number(metrics?.accuracy);
  const rec = Number(metrics?.recall);
  const lat = Number(metrics?.latencyP95);
  const errors = [];
  if (!Number.isFinite(acc) || acc < thresholds.minAccuracy) {
    errors.push(
      `accuracy ${Number.isFinite(acc) ? acc.toFixed(3) : "n/a"} < ${thresholds.minAccuracy}`,
    );
  }
  if (!Number.isFinite(rec) || rec < thresholds.minRecall) {
    errors.push(
      `recall ${Number.isFinite(rec) ? rec.toFixed(3) : "n/a"} < ${thresholds.minRecall}`,
    );
  }
  if (!Number.isFinite(lat) || lat > thresholds.maxLatencyMs) {
    errors.push(
      `latencyP95 ${Number.isFinite(lat) ? `${lat}ms` : "n/a"} > ${thresholds.maxLatencyMs}ms`,
    );
  }
  return { ok: errors.length === 0, errors };
};

// Map a FastAPI status string to our internal enum. Anything unknown
// falls through to "running" — keeps the poll loop alive until the
// server tells us otherwise.
const normaliseStatus = (raw) => {
  const s = String(raw || "").toLowerCase();
  if (s === "queued" || s === "pending") return "queued";
  if (s === "running" || s === "in_progress" || s === "training") return "running";
  if (s === "succeeded" || s === "success" || s === "completed" || s === "done") return "succeeded";
  if (s === "failed" || s === "error" || s === "errored") return "failed";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  return "running";
};

// ---- Public API ----------------------------------------------------------

/**
 * Trigger a retrain on FastAPI. Returns immediately with the jobId;
 * use `getStatus` to poll.
 *
 * @param {object} [opts]
 * @param {string} [opts.datasetVersion]
 * @param {object} [opts.hyperparameters]
 * @returns {Promise<{jobId, status}>}
 */
export const triggerRetrain = async (opts = {}) => {
  pruneOldJobs();
  try {
    const body = {};
    if (typeof opts.datasetVersion === "string" && opts.datasetVersion.length > 0) {
      body.datasetVersion = opts.datasetVersion;
    }
    if (opts.hyperparameters && typeof opts.hyperparameters === "object") {
      body.hyperparameters = opts.hyperparameters;
    }
    const data = await mlPost("/admin/retrain", body, {
      timeoutMs: 30_000,
      retries: 1,
    });
    const jobId = String(data?.jobId || data?.job_id || "").trim();
    if (!jobId) {
      throw internal("FastAPI did not return a jobId for /admin/retrain");
    }
    setJob(jobId, {
      status: "queued",
      progress: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      modelVersion: null,
      reloadedAt: null,
      modelHash: null,
    });
    return { jobId, status: "queued" };
  } catch (err) {
    if (err && err.status) throw err;
    throw internal(`triggerRetrain failed: ${err?.message || err}`);
  }
};

/**
 * Look up the status of a retrain job. Polls FastAPI until the job
 * is terminal or the timeout fires.
 *
 * @param {string} jobId
 * @param {object} [opts]
 * @param {boolean} [opts.wait=false]   — true → poll until terminal.
 * @param {number}  [opts.timeoutMs]    — overrides POLL_TIMEOUT_MS when `wait`.
 * @returns {Promise<{jobId, status, progress, startedAt, finishedAt, error, modelVersion, reloadedAt, modelHash, history}>}
 */
export const getStatus = async (jobId, opts = {}) => {
  if (!jobId) throw badRequest("jobId is required");
  pruneOldJobs();

  const wait = opts.wait === true;
  const deadline = Date.now() + (opts.timeoutMs || POLL_TIMEOUT_MS);

  let lastKnown = getJob(jobId) || null;
  let lastError = null;

  while (true) {
    let fromFastApi = null;
    try {
      const data = await mlGet(`/admin/retrain/${encodeURIComponent(jobId)}`, {
        timeoutMs: 15_000,
        retries: 1,
      });
      fromFastApi = {
        status: normaliseStatus(data?.status),
        progress: normaliseProgress(data?.progress),
        error: data?.error || null,
        modelVersion: data?.modelVersion || data?.model_version || null,
      };
    } catch (err) {
      // Transient FastAPI failure — keep polling until timeout.
      lastError = err;
    }

    if (fromFastApi) {
      const patch = {
        status: fromFastApi.status,
        progress: fromFastApi.progress,
        error: fromFastApi.error,
        modelVersion: fromFastApi.modelVersion,
      };
      if (["succeeded", "failed", "cancelled"].includes(fromFastApi.status)) {
        patch.finishedAt = patch.finishedAt || new Date().toISOString();
      }
      lastKnown = setJob(jobId, patch);

      // Terminal state: run validation + reload if applicable.
      if (fromFastApi.status === "succeeded") {
        await finaliseIfNeeded(jobId);
        lastKnown = getJob(jobId);
      } else if (["failed", "cancelled"].includes(fromFastApi.status)) {
        // No activation. The existing model stays in place.
        if (!lastKnown?.finishedAt) {
          lastKnown = setJob(jobId, {
            status: fromFastApi.status,
            finishedAt: new Date().toISOString(),
          });
        }
      }
    }

    const status = lastKnown?.status || "queued";
    if (!wait || ["succeeded", "failed", "cancelled"].includes(status)) break;
    if (Date.now() >= deadline) {
      // Timed out — return what we have with a synthetic error.
      lastKnown = setJob(jobId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: lastError ? `Polling timed out (${lastError.message || "unknown"})` : "Polling timed out",
      });
      break;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return lastKnown || {
    jobId,
    status: "unknown",
    progress: 0,
    error: "Job not found",
  };
};

// Internal: after a succeeded status, validate + reload. Idempotent
// — if the job already has `reloadedAt`, skip.
const finaliseIfNeeded = async (jobId) => {
  const job = getJob(jobId);
  if (!job || job.status !== "succeeded") return;
  if (job.reloadedAt) return; // already finalised

  // Validation pass.
  let metrics = null;
  let validation = { ok: false, errors: ["metrics endpoint unreachable"] };
  try {
    metrics = await mlGet("/admin/model/metrics", { timeoutMs: 8_000, retries: 1 });
    validation = passesThreshold(metrics || {}, {
      minAccuracy: DEFAULT_MIN_ACCURACY,
      minRecall: DEFAULT_MIN_RECALL,
      maxLatencyMs: DEFAULT_MAX_LATENCY_MS,
    });
  } catch (err) {
    validation = { ok: false, errors: [`metrics fetch failed: ${err?.message || err}`] };
  }

  if (!validation.ok) {
    setJob(jobId, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: `Validation failed: ${validation.errors.join("; ")}`,
      metrics,
    });
    return;
  }

  // Reload the artifact on FastAPI.
  let reloadResult = null;
  try {
    reloadResult = await mlPost("/admin/model/reload", {}, {
      timeoutMs: 15_000,
      retries: 1,
    });
  } catch (err) {
    setJob(jobId, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: `Reload failed: ${err?.message || err}`,
      metrics,
    });
    return;
  }

  setJob(jobId, {
    status: "active",
    finishedAt: new Date().toISOString(),
    reloadedAt: reloadResult?.reloadedAt || reloadResult?.reloaded_at || new Date().toISOString(),
    modelHash: reloadResult?.modelHash || reloadResult?.model_hash || null,
    modelVersion:
      reloadResult?.modelVersion || reloadResult?.model_version || job.modelVersion,
    metrics,
  });

  // Notify the candidate scoring cache.
  invalidateOnModelVersionChange(reloadResult?.modelVersion || job.modelVersion);
};

/**
 * Force a reload of the current artifact on FastAPI. Useful when the
 * admin knows the model.pkl has been swapped out-of-band (e.g. via
 * CI) and wants the live server to pick it up.
 *
 * @returns {Promise<{status, reloadedAt, modelHash}>}
 */
export const reloadActiveModel = async () => {
  const data = await mlPost("/admin/model/reload", {}, {
    timeoutMs: 15_000,
    retries: 1,
  });
  invalidateOnModelVersionChange(data?.modelVersion || data?.model_version || "v1");
  return {
    status: "active",
    reloadedAt: data?.reloadedAt || data?.reloaded_at || new Date().toISOString(),
    modelHash: data?.modelHash || data?.model_hash || null,
  };
};

/**
 * Read-only summary of the in-memory job cache. Useful for ops +
 * tests.
 *
 * NOTE: deliberately named `getJobCacheStats` (not `getCacheStats`)
 * to avoid colliding with `candidateScoringService.getCacheStats`.
 */
export const getJobCacheStats = () => {
  pruneOldJobs();
  const out = [];
  for (const [, job] of _jobs.entries()) {
    out.push({
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      finishedAt: job.finishedAt,
    });
  }
  return {
    activeJobs: out.filter((j) => !j.finishedAt).length,
    finishedJobs: out.filter((j) => !!j.finishedAt).length,
    jobs: out,
    candidateScoringCache: safeCandidateStats(),
  };
};

const safeCandidateStats = () => {
  try {
    return getCacheStats();
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Example usage
// ---------------------------------------------------------------------------
//
//   import {
//     triggerRetrain, getStatus, reloadActiveModel, getJobCacheStats,
//   } from "./retrainingService.mjs";
//
//   // Async fire-and-forget:
//   const { jobId } = await triggerRetrain({ datasetVersion: "v3" });
//
//   // Long-poll until terminal:
//   const final = await getStatus(jobId, { wait: true });
//   // final.status === 'active' | 'failed' | 'cancelled'
//
//   // Force a reload after a manual artifact swap:
//   await reloadActiveModel();
//
//   // Ops summary:
//   const stats = getJobCacheStats();
//
// ---------------------------------------------------------------------------
// Suggested unit tests
// ---------------------------------------------------------------------------
//
//   - normaliseStatus maps FastAPI strings to the internal enum.
//   - passesThreshold rejects metrics below thresholds.
//   - normaliseProgress clamps to [0, 1].
//   - pruneOldJobs removes finished jobs older than JOB_TTL_MS.
//   - setJob is idempotent (merges with prior state).
//
// ---------------------------------------------------------------------------
// Assumptions
// ---------------------------------------------------------------------------
//
//   - FastAPI exposes:
//       POST /admin/retrain           → { jobId }
//       GET  /admin/retrain/{jobId}   → { status, progress, error?, modelVersion? }
//       GET  /admin/model/metrics     → { accuracy, recall, latencyP95 }
//       POST /admin/model/reload      → { reloadedAt, modelHash, modelVersion }
//   - The project keeps a single artifact (model.pkl); there is no
//     version history. On validation failure the prior artifact
//     remains in place because we never replace it until validation
//     passes.
//
// ---------------------------------------------------------------------------
// Reusable functions
// ---------------------------------------------------------------------------
//
//   - `mlPost` / `mlGet` from `utils/mlClient.mjs` — single owner of
//     FastAPI HTTP. If the ML endpoints change, only this service
//     needs to update.
//   - `invalidateOnModelVersionChange` from `candidateScoringService`
//     — wired automatically on activation.
//
// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
//
//   - Already-shaped `badRequest`/`internal` from `mlClient` propagate.
//   - Polling errors are swallowed per-tick (logged via console.warn
//     inside mlClient) so transient blips don't kill the loop. We
//     only escalate when the deadline expires.
//   - The job's terminal `error` field is set on validation failure
//     or reload failure so the admin can see why activation didn't
//     happen.