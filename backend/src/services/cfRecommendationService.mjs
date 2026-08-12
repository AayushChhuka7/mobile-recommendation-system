// ---------------------------------------------------------------------------
// CF (collaborative-filtering) recommendation service.
//
// Bridges the existing Node/Express backend to the new
// `ML Model/filtering/cf_service/` FastAPI service running on port 9001.
//
// Responsibilities:
//   1. Resolve a CF `customer_id` for an authenticated app user.
//      Imported users (from `customer_dataset.csv`) have an email of
//      the form `${customerId}@import.local`, so the inverse is a
//      prefix split on `@`. Real registrations have no CF counterpart
//      and we pass a synthetic id — the CF model's cold-start fallback
//      returns global popularity, so the user still gets recommendations.
//   2. Lazy-populate `CustomerCluster` on first lookup so the
//      segmentation column doesn't have to be computed offline.
//      `cluster_id` is derived from the same CSV the trained model
//      produced (`customer_profiles_with_clusters.csv`).
//   3. Hit `/recommend?customer_id=...&top_n=...` on the CF service
//      with a short timeout. Failure → empty results + warn log.
//      The hybrid merge in `recommendService` will then silently
//      degrade to the existing content-based list.
//   4. Fire-and-forget log into `cf_recommendation_logs` so admins
//      can see what the CF side served.
//
// IMPORTANT: this service NEVER throws. The contract is:
//
//   getCfRecommendations(userId, topN) → { results, coldStart, customerId, error? }
//
// `results` is always an array (possibly empty). Callers can rely on
// the shape and on the fact that a missing/broken CF service yields
// `results: []` rather than an exception.
// ---------------------------------------------------------------------------

import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

import { CF_BASE_URL } from "../config/cf.mjs";
import { prisma } from "../config/prisma.mjs";

// ---------------------------------------------------------------------------
// Paths — resolved at runtime so the same code runs on Windows (host
// dev) and Linux (Docker) without edits. Repo root is 3 levels up
// from this file: `backend/src/services/` → `backend/src/` → `backend/`
// → `<repo-root>/`.
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_CLUSTER_CSV = path.join(
  REPO_ROOT,
  "ML Model",
  "filtering",
  "02_segmentation",
  "output",
  "cluster_profiles.csv",
);
const DEFAULT_PROFILES_CSV = path.join(
  REPO_ROOT,
  "ML Model",
  "filtering",
  "02_segmentation",
  "output",
  "customer_profiles_with_clusters.csv",
);

// Env-overridable so Docker / CI can point at a different location.
const CLUSTER_PROFILES_PATH =
  process.env.CLUSTER_PROFILES_CSV || DEFAULT_CLUSTER_CSV;
const CUSTOMER_PROFILES_PATH =
  process.env.CUSTOMER_PROFILES_CSV || DEFAULT_PROFILES_CSV;

// ---------------------------------------------------------------------------
// In-memory caches (lazily populated, never refreshed — the CSVs are
// trained artefacts that don't change at runtime).
// ---------------------------------------------------------------------------
let _clusterNamesById = null; // Map<number, string>
let _userClusterByCustomerId = null; // Map<string, {cluster_id, cluster_name}>

// ---------------------------------------------------------------------------
// Tiny CSV reader — enough for the segmentation outputs (no embedded
// quotes, no multi-line fields). Avoids pulling in `csv-parse` here.
// ---------------------------------------------------------------------------
function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l && l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split(",");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = cols[j];
    rows.push(obj);
  }
  return rows;
}

function ensureClusterMaps() {
  if (_clusterNamesById && _userClusterByCustomerId) return;
  _clusterNamesById = new Map();
  _userClusterByCustomerId = new Map();

  // cluster_profiles.csv — one row per cluster, with a `cluster_name`
  // column. This gives us the human-readable name for an integer id.
  const clusterRows = readCsv(CLUSTER_PROFILES_PATH);
  for (const row of clusterRows) {
    const id = Number(row.cluster_id);
    if (Number.isFinite(id) && row.cluster_name) {
      _clusterNamesById.set(id, String(row.cluster_name));
    }
  }

  // customer_profiles_with_clusters.csv — one row per CF customer.
  // We only need customer_id, cluster_id, cluster_name.
  const profileRows = readCsv(CUSTOMER_PROFILES_PATH);
  for (const row of profileRows) {
    if (!row.customer_id) continue;
    _userClusterByCustomerId.set(String(row.customer_id), {
      cluster_id: row.cluster_id != null ? Number(row.cluster_id) : null,
      cluster_name: row.cluster_name || null,
    });
  }
}

// Look up the cluster the KMeans segmentation training assigned to a
// given CF customer_id. We don't run KMeans at inference — we just
// reuse the same CSV the trained model was fit on, so the cluster IDs
// are guaranteed to match what the CF model expects.
function getClusterForCustomerId(customerId) {
  ensureClusterMaps();
  if (!customerId) return null;
  return _userClusterByCustomerId.get(customerId) || null;
}

// Friendly name for a cluster id. Returns a "Cluster N" fallback when
// the CSV is missing — never null, so the FE can always render something.
function getClusterName(clusterId) {
  ensureClusterMaps();
  if (clusterId == null) return null;
  return _clusterNamesById.get(Number(clusterId)) || `Cluster ${clusterId}`;
}

// ---------------------------------------------------------------------------
// CF service health — used by recommendService.checkHealth to surface
// the overall recommendation health (ml-service + cf-service).
// ---------------------------------------------------------------------------
const CF_HEALTH_TIMEOUT_MS = 2000;

export async function checkCfHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CF_HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${CF_BASE_URL}/health`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      return { status: "unhealthy", statusCode: res.status };
    }
    const data = await res.json().catch(() => ({}));
    return {
      status: data.status || "ok",
      n_users: data.n_users,
      n_items: data.n_items,
    };
  } catch (err) {
    return {
      status: "unreachable",
      error:
        err && err.name === "AbortError"
          ? "timeout"
          : (err && (err.message || String(err))) || "unknown",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// customer_id resolution.
//
// App users imported from `customer_dataset.csv` get an email of the
// form `${customerId}@import.local`. Real registrations (the Login /
// Register flow) get a normal email and have NO CF counterpart.
//
// We memoize the resolved customerId on the `CustomerCluster` row so
// we don't have to scan Users on every recommendation call.
// ---------------------------------------------------------------------------
const IMPORT_EMAIL_RE = /^([A-Z0-9-]+)@import\.local$/i;

async function resolveCfCustomerId(userId) {
  if (!userId) return null;

  // 1. Fast path — read the cached CustomerCluster row.
  try {
    const cluster = await prisma.customerCluster.findUnique({
      where: { userId: String(userId) },
      select: { cfCustomerId: true },
    });
    if (cluster && cluster.cfCustomerId) return cluster.cfCustomerId;
  } catch (err) {
    // DB error — log and fall through to the email-pattern fallback.
    console.warn("[cf] CustomerCluster lookup failed:", err?.message || err);
  }

  // 2. Fallback — read the user's email and split on `@` if it matches
  //    the `@import.local` pattern. No row write here: if the user
  //    doesn't have an import email, there's no CF counterpart.
  try {
    const user = await prisma.users.findUnique({
      where: { userId: String(userId) },
      select: { email: true },
    });
    if (!user || !user.email) return null;
    const m = IMPORT_EMAIL_RE.exec(String(user.email).trim());
    if (!m) return null;
    return m[1].toUpperCase();
  } catch (err) {
    console.warn("[cf] Users.email lookup failed:", err?.message || err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// /recommend call with timeout + graceful failure.
//
// 8 s matches the existing `mlFetch` timeout in `recommendService.mjs`
// so the two pipelines have comparable fail-fast semantics.
// ---------------------------------------------------------------------------
const CF_RECOMMEND_TIMEOUT_MS = 8000;

async function callCfService(customerId, topN) {
  const url = `${CF_BASE_URL}/recommend?customer_id=${encodeURIComponent(
    customerId,
  )}&top_n=${encodeURIComponent(String(topN))}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CF_RECOMMEND_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        results: [],
        coldStart: true,
        error: `CF service HTTP ${res.status}`,
      };
    }
    return {
      results: Array.isArray(data.results) ? data.results : [],
      coldStart: Boolean(data.cold_start),
      error: null,
    };
  } catch (err) {
    return {
      results: [],
      coldStart: true,
      error:
        err && err.name === "AbortError"
          ? "CF service timeout"
          : (err && (err.message || String(err))) || "unknown",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public entry point. Always returns a clean envelope:
//
//   {
//     results:    [{ model_name, score, reason }],
//     coldStart:  bool,
//     customerId: string | null,   // CF customer_id used (null for
//                                  // users with no CF counterpart)
//     cluster:    { id, name } | null,
//     error:      string | null,   // non-null on timeout / unreachable
//   }
//
// `recommendService.mjs` calls this from inside its hybrid merge and
// checks `results.length === 0` to decide whether to fall back to
// content-only recommendations.
// ---------------------------------------------------------------------------
export async function getCfRecommendations(userId, topN = 10) {
  if (!userId) {
    return {
      results: [],
      coldStart: true,
      customerId: null,
      cluster: null,
      error: null,
    };
  }
  const safeTopN = Math.max(1, Math.min(50, Number(topN) || 10));

  const customerId = await resolveCfCustomerId(userId);
  if (!customerId) {
    // No CF counterpart for this user (real registration, no
    // `@import.local` email). The CF model would still return global
    // popularity, but it's a wasted round-trip — the existing
    // content-based recommender already serves cold-start users well.
    return {
      results: [],
      coldStart: true,
      customerId: null,
      cluster: null,
      error: null,
    };
  }

  const cluster = getClusterForCustomerId(customerId);

  const { results, coldStart, error } = await callCfService(
    customerId,
    safeTopN,
  );

  if (error) {
    // Soft-fail — log so ops can see it but never propagate.
    console.warn(`[cf] recommend failed for ${customerId}: ${error}`);
  }

  // Normalize the cluster envelope from CSV-shape
  // (`{cluster_id, cluster_name}`) to the public `{id, name}` shape
  // the BE's other callers expect. Keeping the raw keys here would
  // force every consumer to know about the CSV column names, which
  // is a leak — `recommendService` and any future controller route
  // should never need to touch the CSV contract directly.
  const normalizedCluster = cluster
    ? { id: cluster.cluster_id, name: cluster.cluster_name }
    : null;

  return {
    results,
    coldStart,
    customerId,
    cluster: normalizedCluster,
    error,
  };
}

// ---------------------------------------------------------------------------
// Fire-and-forget analytics log into `cf_recommendation_logs`.
// Writes are best-effort — never awaited by callers, never throws.
// ---------------------------------------------------------------------------
export async function safeRecordCfLog(userId, payload) {
  if (!userId) return;
  const {
    cfCustomerId = null,
    coldStart = false,
    results = [],
  } = payload || {};
  if (!Array.isArray(results) || results.length === 0) return;

  const modelNames = results.map((r) => r.model_name || "").join("\n");
  const scores = results.map((r) => String(r.score ?? 0)).join("\n");
  const reasons = results.map((r) => r.reason || "").join("\n");

  try {
    await prisma.cfRecommendationLog.create({
      data: {
        userId: String(userId),
        cfCustomerId: cfCustomerId || null,
        isColdStart: Boolean(coldStart),
        modelNames,
        scores,
        reasons,
      },
    });
  } catch (err) {
    console.warn("[cf] log write failed:", err?.message || err);
  }
}

// ---------------------------------------------------------------------------
// Persist (or update) the CustomerCluster row once we have a CF
// customer_id for the user. Idempotent — safe to call on every
// recommendation. Caller decides whether to await (typically
// fire-and-forget) so this never blocks the recommendation path.
// ---------------------------------------------------------------------------
export async function safeUpsertCustomerCluster(
  userId,
  { cfCustomerId, clusterId, clusterName },
) {
  if (!userId || clusterId == null) return;
  try {
    await prisma.customerCluster.upsert({
      where: { userId: String(userId) },
      create: {
        userId: String(userId),
        clusterId: Number(clusterId),
        clusterName: clusterName || `Cluster ${clusterId}`,
        cfCustomerId: cfCustomerId || null,
      },
      update: {
        clusterId: Number(clusterId),
        clusterName: clusterName || `Cluster ${clusterId}`,
        cfCustomerId: cfCustomerId || null,
      },
    });
  } catch (err) {
    console.warn("[cf] cluster upsert failed:", err?.message || err);
  }
}

// Re-export the cluster-name lookup so callers (controllers) can
// resolve a human-readable name without re-importing the internal
// helpers.
export { getClusterName, getClusterForCustomerId };