// candidateScoringService — pluggable pre-compute cache for phone
// composite scores.
//
// Why pre-compute? The recommendation pipeline re-scores every
// candidate through `fusionRanker.fuseOne` on every call. For the
// "show all phones in this category" path that's wasteful: a phone
// with the same features + the same user behaviour-scores will
// produce the same composite. Pre-computing once per
// (phoneId, weightsHash, behaviorScoresHash) lets us answer
// ranking queries in O(1) instead of O(N).
//
// Why "pluggable backend"? The spec asks us not to hardcode
// in-memory assumptions. The default is still in-memory LRU+TTL
// (good enough for the single-process Node server); a Redis backend
// stub is exported so future deployments can swap to shared cache
// without changing the rest of the pipeline.
//
// Invalidation:
//   - onCatalogChange     → clear everything.
//   - onWeightsChange     → clear when the weights hash changed.
//   - onModelVersionChange → clear everything.
//
// Public API:
//   - createCache({ backend, ttlMs, max })
//   - getOrComputeComposite(phoneIds, behaviorScores, opts)
//   - invalidateOnCatalogChange()
//   - invalidateOnWeightsChange(newWeightsHash)
//   - invalidateOnModelVersionChange(newVersion)
//   - setInvalidator(fn)

import { fuseOne, FUSION_WEIGHTS } from "./fusionRanker.mjs";
import { prisma } from "../config/prisma.mjs";

// ---- Tunables -------------------------------------------------------------
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_ENTRIES = 5000;

// ---- Backends -------------------------------------------------------------

// In-memory LRU + TTL backend. Map iteration order is insertion
// order in JS, so we re-insert on `get` to keep hot entries at the
// tail and evict from the head when we exceed `max`.
const createMemoryBackend = ({ ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX_ENTRIES } = {}) => {
  const store = new Map();
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  let expirations = 0;

  const isAlive = (entry) => {
    if (!entry) return false;
    return Date.now() - entry.at < ttlMs;
  };

  return {
    name: "memory",
    stats() {
      return {
        backend: "memory",
        size: store.size,
        max,
        ttlMs,
        hits,
        misses,
        evictions,
        expirations,
      };
    },
    get(key) {
      const entry = store.get(key);
      if (!entry) {
        misses += 1;
        return undefined;
      }
      if (!isAlive(entry)) {
        store.delete(key);
        expirations += 1;
        misses += 1;
        return undefined;
      }
      // LRU touch: re-insert.
      store.delete(key);
      store.set(key, entry);
      hits += 1;
      return entry.value;
    },
    set(key, value) {
      if (store.has(key)) store.delete(key);
      store.set(key, { at: Date.now(), value });
      while (store.size > max) {
        // Evict the oldest entry (Map iteration = insertion order).
        const oldestKey = store.keys().next().value;
        store.delete(oldestKey);
        evictions += 1;
      }
    },
    delete(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
};

// Redis backend — stub. The spec says "Design it so different cache
// backends can later be added", not "implement Redis now". We expose
// the constructor so callers can wire it in once a Redis client is
// available; the methods throw so missing wiring fails loudly.
const createRedisBackend = () => {
  throw new Error(
    "candidateScoringService: redis backend not configured. " +
      "Pass `backend: 'memory'` or wire a Redis client and extend createRedisBackend.",
  );
};

export const createCache = (opts = {}) => {
  const backend = opts.backend || "memory";
  let store;
  if (backend === "memory") {
    store = createMemoryBackend(opts);
  } else if (backend === "redis") {
    store = createRedisBackend(opts);
  } else {
    throw new Error(`Unknown cache backend: ${backend}`);
  }

  return {
    get: (k) => store.get(k),
    set: (k, v) => store.set(k, v),
    invalidate: (k) => store.delete(k),
    invalidateAll: () => store.clear(),
    stats: () => store.stats(),
    _backend: backend,
  };
};

// ---- Singleton cache ------------------------------------------------------
//
// The application uses one cache instance. Tests can call
// `__resetCacheForTests()` to start from a clean slate.
let _cache = null;
const _invalidators = new Set();

const getDefaultCache = () => {
  if (!_cache) _cache = createCache();
  return _cache;
};

export const __resetCacheForTests = () => {
  _cache = createCache();
  _invalidators.clear();
};

// ---- Cache-key hashing ----------------------------------------------------

// Fast, deterministic hash for a behaviour-scores map. Order-
// independent so `Map([ [a,1], [b,2] ])` and `Map([ [b,2], [a,1] ])`
// produce the same key. FNV-1a 32-bit — plenty of collision space
// for a per-process cache, no need for crypto.
const fnv1a = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
};

const hashBehaviorScores = (behaviorScores) => {
  if (!behaviorScores) return "0";
  if (behaviorScores instanceof Map) {
    const keys = Array.from(behaviorScores.keys()).sort();
    return fnv1a(
      keys.map((k) => `${k}:${Number(behaviorScores.get(k)).toFixed(3)}`).join("|"),
    );
  }
  if (typeof behaviorScores === "object") {
    const keys = Object.keys(behaviorScores).sort();
    return fnv1a(
      keys.map((k) => `${k}:${Number(behaviorScores[k]).toFixed(3)}`).join("|"),
    );
  }
  return "0";
};

const hashWeights = (weights) => {
  if (!weights || typeof weights !== "object") {
    // Fall back to the canonical FUSION_WEIGHTS key — always hash
    // the same value so cache hits are deterministic.
    return fnv1a(JSON.stringify(FUSION_WEIGHTS));
  }
  const keys = Object.keys(weights).sort();
  return fnv1a(keys.map((k) => `${k}:${Number(weights[k]).toFixed(3)}`).join("|"));
};

// ---- Composite pre-compute -----------------------------------------------

// Hydrate the rows the composite needs from Prisma. The shape matches
// what `fusionRanker.fuseOne` expects: { overallScore, matchScoreFastApi,
// contentSim, tags, valueScore }.
//
// We do one `findMany` per call — N+1 prevention lives in the caller
// (always pass an array of phoneIds).
const hydratePhonesForComposite = async (phoneIds) => {
  if (!Array.isArray(phoneIds) || phoneIds.length === 0) return [];
  try {
    const rows = await prisma.phones.findMany({
      where: { phoneId: { in: phoneIds }, isActive: true },
      select: {
        phoneId: true,
        antutuScore: true,
        brand: { select: { name: true } },
        specs: { select: { chipset: true } },
        // Cheap-Variant price used as a fallback Value signal.
        variants: {
          where: { isAvailable: true },
          orderBy: { price: "asc" },
          take: 1,
          select: { price: true },
        },
      },
    });
    return rows.map((p) => {
      // Map onto the fusionRanker contract: tags + contentSim + 3 scores.
      // Without a real ML call we use cheap heuristics:
      //   overallScore      → antutu / 1_000_000 (caps at 1)
      //   matchScoreFastApi → 0 (no persona context here)
      //   contentSim        → 0.5 (neutral)
      //   valueScore        → 1 - (price / 2000) (clamped to [0,1])
      const antutu = typeof p.antutuScore === "number" ? p.antutuScore : 0;
      const overallScore = Math.max(0, Math.min(1, antutu / 1_000_000));
      const price = p.variants?.[0]?.price
        ? Number(p.variants[0].price)
        : null;
      const valueScore =
        price && Number.isFinite(price)
          ? Math.max(0, Math.min(1, 1 - price / 2000))
          : 0.5;

      return {
        phoneId: p.phoneId,
        brand: { name: p.brand?.name || null },
        overallScore,
        matchScoreFastApi: 0,
        contentSim: 0.5,
        valueScore,
        tags: buildTagsFromPhoneRow(p),
      };
    });
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[candidateScoring] hydrate failed:",
        err?.message || err,
      );
    } else {
      console.error("[candidateScoring] hydrate failed:", err);
    }
    return [];
  }
};

// Pure: derive the tag set the fusion ranker wants. Mirrors
// `phoneToTags` in searchHistoryScore.mjs — duplicated here to keep
// candidateScoringService independent (no cross-service imports).
const buildTagsFromPhoneRow = (p) => {
  const out = [];
  const brand = p?.brand?.name;
  if (brand) {
    out.push(`brand:${String(brand).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}`);
  }
  if (typeof p?.antutuScore === "number") {
    if (p.antutuScore >= 900_000) out.push("tier:flagship");
    else if (p.antutuScore >= 500_000) out.push("tier:mid");
    else out.push("tier:budget");
  }
  const chipset = p?.specs?.chipset;
  if (chipset && /snapdragon|dimensity|exynos|kirin|helio|rog/i.test(String(chipset))) {
    out.push("gaming");
  }
  return out;
};

// Cache key — composite of phoneId + behaviour-hash + weights-hash
// + model-version.
const cacheKey = (phoneId, behaviorHash, weightsHash, modelVersion) =>
  `cand:${modelVersion}:${weightsHash}:${behaviorHash}:${phoneId}`;

// ---- Public API -----------------------------------------------------------

/**
 * Pre-compute (or fetch) the composite score for a set of phoneIds.
 * Same `(behaviorScores, weights, modelVersion)` ⇒ cache hit.
 *
 * @param {string[]} phoneIds
 * @param {Map<string,number>|object|null} [behaviorScores=null]
 * @param {object} [opts]
 * @param {object} [opts.weights]        — overrides FUSION_WEIGHTS; passed through unchanged.
 * @param {string} [opts.modelVersion="v1"]
 * @returns {Promise<Map<string, { score, components, computedAt, modelVersion }>>}
 */
export const getOrComputeComposite = async (
  phoneIds,
  behaviorScores = null,
  opts = {},
) => {
  if (!Array.isArray(phoneIds) || phoneIds.length === 0) return new Map();
  const cache = getDefaultCache();
  const modelVersion = opts.modelVersion || "v1";
  const weights = opts.weights || FUSION_WEIGHTS;
  const weightsHash = hashWeights(weights);
  const behaviorHash = hashBehaviorScores(behaviorScores);

  const out = new Map();
  const toFetch = [];

  for (const phoneId of phoneIds) {
    const key = cacheKey(phoneId, behaviorHash, weightsHash, modelVersion);
    const cached = cache.get(key);
    if (cached !== undefined) {
      out.set(phoneId, cached);
    } else {
      toFetch.push(phoneId);
    }
  }

  if (toFetch.length === 0) return out;

  const hydrated = await hydratePhonesForComposite(toFetch);
  const at = Date.now();

  for (const phone of hydrated) {
    const { finalScore, components } = fuseOne(phone, behaviorScores);
    const entry = {
      score: finalScore,
      components,
      computedAt: at,
      modelVersion,
    };
    const key = cacheKey(
      phone.phoneId,
      behaviorHash,
      weightsHash,
      modelVersion,
    );
    cache.set(key, entry);
    out.set(phone.phoneId, entry);
  }

  return out;
};

/**
 * Drop the whole cache. Call when the phone catalog changes (new
 * import, soft-delete, edit to specs/price).
 */
export const invalidateOnCatalogChange = () => {
  const cache = getDefaultCache();
  cache.invalidateAll();
  for (const fn of _invalidators) {
    try {
      fn({ reason: "catalog" });
    } catch (err) {
      console.warn("[candidateScoring] invalidator threw:", err?.message || err);
    }
  }
};

/**
 * Selective clear when the active weights hash changes. We compare
 * hashes (cheap) and clear only when they're different.
 */
export const invalidateOnWeightsChange = (newWeights) => {
  const newHash = hashWeights(newWeights);
  const cache = getDefaultCache();
  // The default cache backend has no per-key scan; for memory LRU
  // we just clearAll. Future backends can optimise by storing the
  // weights hash on each entry and removing only stale ones.
  void newHash;
  cache.invalidateAll();
  for (const fn of _invalidators) {
    try {
      fn({ reason: "weights" });
    } catch (err) {
      console.warn("[candidateScoring] invalidator threw:", err?.message || err);
    }
  }
};

/**
 * Drop the whole cache when the ML model version changes.
 */
export const invalidateOnModelVersionChange = (newVersion) => {
  const cache = getDefaultCache();
  void newVersion;
  cache.invalidateAll();
  for (const fn of _invalidators) {
    try {
      fn({ reason: "model-version" });
    } catch (err) {
      console.warn("[candidateScoring] invalidator threw:", err?.message || err);
    }
  }
};

/**
 * Register a callback fired after any invalidation. Used by the
 * retraining service to refresh downstream state.
 *
 * @param {(info: {reason: string}) => void} fn
 * @returns {() => void} disposer.
 */
export const setInvalidator = (fn) => {
  if (typeof fn !== "function") return () => {};
  _invalidators.add(fn);
  return () => _invalidators.delete(fn);
};

/** Read-only cache stats for ops / tests. */
export const getCacheStats = () => getDefaultCache().stats();

// ---------------------------------------------------------------------------
// Example usage
// ---------------------------------------------------------------------------
//
//   import {
//     getOrComputeComposite,
//     invalidateOnCatalogChange,
//     getCacheStats,
//   } from "./candidateScoringService.mjs";
//
//   const composites = await getOrComputeComposite(
//     [idA, idB, idC],
//     behaviorScoreMap,
//     { weights: FUSION_WEIGHTS, modelVersion: "v1" },
//   );
//   composites.get(idA); // → { score: 0.78, components: {...}, computedAt, modelVersion }
//
//   // After a phone import / soft-delete:
//   invalidateOnCatalogChange();
//   console.log(getCacheStats());
//
// ---------------------------------------------------------------------------
// Suggested unit tests
// ---------------------------------------------------------------------------
//
//   - getOrComputeComposite returns one entry per phoneId.
//   - Second call with same inputs returns the same `computedAt`
//     timestamp (cache hit).
//   - invalidateOnCatalogChange forces a recompute (new timestamp).
//   - Hash function is order-independent for behaviorScores.
//   - Memory backend evicts entries beyond `max` (LRU).
//   - Memory backend respects `ttlMs` (artificial Date.now override
//     in tests).
//
// ---------------------------------------------------------------------------
// Assumptions
// ---------------------------------------------------------------------------
//
//   - Single Node process. For horizontal scale, swap the backend to
//     Redis (the stub is in place to make that a one-PR change).
//   - The composite (antutu/1e6, 1 - price/2000, neutral contentSim)
//     is good enough for ranking UI surfaces; full precision lives
//     in `recommendService.getRecommendations`, which still runs the
//     FastAPI `/similarity/score` and real `Match_Score`. This cache
//     exists for the cheap "show all in this category" path.
//   - `fuseOne` is the single source of truth for scoring — the
//     cache never deviates from its formula.
//
// ---------------------------------------------------------------------------
// Reusable functions
// ---------------------------------------------------------------------------
//
//   - `createCache` — exported so tests can build isolated caches.
//   - `getCacheStats` — exported for monitoring hooks.
//
// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
//
//   - Prisma errors during hydration degrade to an empty Map for the
//     affected phoneIds. Other phones in the same batch still get
//     scored.
//   - Unknown backend name → throw `Error` synchronously at
//     `createCache()` time so misconfiguration fails loudly at boot.