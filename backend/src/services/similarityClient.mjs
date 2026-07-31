// similarityClient — Step D. Thin wrapper around FastAPI's
// /similarity/score endpoint. Keeps the 566 MB sklearn bundle out
// of the BE process; the BE only ever sees per-candidate cosine
// scores in [0, 1].
//
// Approach: item-item style. Each candidate's score is its cosine
// similarity to the *centroid* of the input candidates. No separate
// "seed phone" is needed — the FastAPI top-N (after persona + budget
// + brand filters) is a self-contained set the user might like.
//
// Failure mode: if FastAPI can't load the bundle (bundle missing,
// OOM, slow first hit), every candidate gets similarity = 0 and the
// other 4 signals still rank correctly. We never block the response.

import { ML_BASE_URL } from "../config/ml.mjs";

const TIMEOUT_MS = 15000; // First hit lazy-loads the 566 MB bundle — give it room.

const similarityFetch = async (path, options = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${ML_BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!res.ok) {
      // 503 from FastAPI = bundle not loaded yet (or load failed).
      // Any other non-2xx is a real error. We surface both via the
      // try/catch in the caller, which always returns 0-scores.
      const body = await res.text().catch(() => "");
      throw new Error(
        `similarity HTTP ${res.status}: ${body.slice(0, 200) || "no body"}`,
      );
    }

    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

// Build the neutral "0 for everyone" fallback the caller uses on
// any error path. Kept as a helper so the shape is identical to a
// successful response and the BE doesn't need to special-case.
function neutralScores(candidates) {
  return candidates.map((c) => ({
    brand: c.brand,
    modelName: c.modelName,
    similarityToMean: 0,
  }));
}

// POST /similarity/score
// Body: { candidates: [{ brand, modelName }, ...] }
// Returns: [{ brand, modelName, similarityToMean }, ...]
//
// Every input candidate gets exactly one output row — either its
// real cosine score, or 0 if the bundle couldn't load / the phone
// wasn't in the bundle's df.
export async function fetchContentSimilarity(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  try {
    const res = await similarityFetch("/similarity/score", {
      method: "POST",
      body: JSON.stringify({ candidates }),
    });
    const rows = Array.isArray(res?.scores) ? res.scores : [];
    // Backfill any candidate FastAPI didn't echo (shouldn't happen,
    // but defensive — keeps the BE from guessing alignments).
    const seen = new Set(
      rows.map((r) => `${r.brand}::${r.modelName}`),
    );
    for (const c of candidates) {
      const key = `${c.brand}::${c.modelName}`;
      if (!seen.has(key)) {
        rows.push({
          brand: c.brand,
          modelName: c.modelName,
          similarityToMean: 0,
        });
      }
    }
    return rows;
  } catch (err) {
    // Step D degradation policy: log + neutral scores, never block.
    console.warn(
      "[step-d] similarity fetch failed, falling back to neutral scores:",
      err?.message || err,
    );
    return neutralScores(candidates);
  }
}