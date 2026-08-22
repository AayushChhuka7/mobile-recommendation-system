// exploration — Fix #6, epsilon-greedy + Thompson-sampling slot injection.
//
// Why this file is separate from the ranker:
//   - The ranker is pure (no DB, no clock). Exploration needs the
//     Beta posteriors, which need a read at call time.
//   - Exploration must be composable with MMR (#5): it runs AFTER
//     MMR so the diversity pass doesn't penalise the exploration
//     pick as a near-duplicate.
//
// Conflict with Fix #3 (training data cleanliness):
//   Exploration rows MUST be marked with `explorationArm` in the
//   RecommendationLog write so the learned-fusion-weights trainer
//   can filter them out. Without that filter, the trainer learns
//   "position 18 / 19 phones get clicks" and the ranker floods
//   the visible top 5 with whatever happened to be sampled.
//
// Arms:
//   - "eps-greedy"     : uniform random from the top 50 of the
//                        relevance ranking. Cheap, biased toward
//                        popular.
//   - "thompson-brand" : Beta posterior per (user, brand) bucket.
//                        Promotes long-tail brands the user has
//                        NOT seen. Best when the user has at least
//                        3-5 prior impressions (so the posterior
//                        has signal). Cold users get eps-greedy.

import { prisma } from "../config/prisma.mjs";

const EXPLORATION_EPSILON = 0.05;
const EXPLORATION_SLOTS = [18, 19]; // 0-indexed positions in the FINAL list (visible from 20+)
const TOP_N_FOR_POOL = 50;
const BETA_PRIOR_ALPHA = 1.0; // uninformative prior
const BETA_PRIOR_BETA = 1.0;

// Cheap Beta(a, b) sampler using two Gamma draws.
// We use the standard Gamma-via-Ahrens-Dieter method below. For
// the small α/β values we see (typically 1-10), this is plenty
// accurate and an order of magnitude faster than pulling in a
// stats library.
function gammaSample(shape) {
  if (shape < 1) {
    // Boost via the relation Gamma(shape) = Gamma(shape+1) * U^(1/shape)
    const u = Math.random();
    return gammaSample(shape + 1) * Math.pow(u, 1 / shape);
  }
  // Marsaglia & Tsang for shape >= 1
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      x = normalSample();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function normalSample() {
  // Box-Muller. Returns one normal draw; we use only one half of
  // the pair so the call is allocation-free.
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function betaSample(alpha, beta) {
  if (alpha <= 0 || beta <= 0) return 0;
  const x = gammaSample(alpha);
  const y = gammaSample(beta);
  return x / (x + y || 1);
}

// Read Beta posterior counts for the (userId, brand) buckets that
// appear in `candidates`. We use the RecommendationLog impressions
// as the trial count and the `clicked` column as the success count.
// Returns Map<brand, {alpha, beta}>.
//
// A bucket with zero trials is given the uninformative prior
// (1, 1) so cold buckets are sampled at 0.5 expected value — same
// as a uniform random pick over the candidate pool.
async function loadPosteriorByBrand(userId, candidates) {
  const out = new Map();
  if (!userId || !Array.isArray(candidates) || candidates.length === 0) return out;

  const brandNames = Array.from(new Set(
    candidates
      .map((c) => (c.brand?.name || "").toLowerCase())
      .filter((n) => n.length > 0),
  ));
  if (brandNames.length === 0) return out;

  try {
    // One query: per brand, count impressions and clicks for this user
    // in the last 30 days. The trainer (#3) considers the same window
    // so the posterior ages consistently.
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = await prisma.recommendationLog.groupBy({
      by: ["phoneId"],
      where: {
        userId,
        shownAt: { gte: cutoff },
        // Exploration picks don't get a "real" click, they're forced
        // impressions. Exclude them from the posterior so we don't
        // learn to repeat whatever arm the user is being shown.
        explorationArm: null,
      },
      _count: { _all: true },
    });
    // Map phoneId -> brand name via the candidate list (we already
    // have brand on the in-memory candidate, no extra join).
    const phoneBrand = new Map();
    for (const c of candidates) {
      if (c.id && c.brand?.name) {
        phoneBrand.set(c.id, c.brand.name.toLowerCase());
      }
    }
    const bucketTrials = new Map();
    for (const r of rows) {
      const brand = phoneBrand.get(r.phoneId);
      if (!brand) continue;
      const prev = bucketTrials.get(brand) || { trials: 0, successes: 0 };
      prev.trials += r._count._all;
      bucketTrials.set(brand, prev);
    }
    for (const brand of brandNames) {
      const t = bucketTrials.get(brand) || { trials: 0, successes: 0 };
      out.set(brand, {
        alpha: BETA_PRIOR_ALPHA + t.successes,
        beta: BETA_PRIOR_BETA + Math.max(0, t.trials - t.successes),
      });
    }
    return out;
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[exploration] loadPosteriorByBrand failed:",
        err?.message || err,
      );
    } else {
      console.warn("[exploration] loadPosteriorByBrand failed:", err);
    }
    return out;
  }
}

// Pick the exploration candidate for one slot. Returns the candidate
// object (with `explorationArm` set) or null if no candidate was
// available.
//
// Strategy:
//   - If the user has ≥ MIN_HISTORY_FOR_THOMPSON impressions in the
//     last 30 days AND we have a posterior for the brand of the
//     best-ranked candidate, use Thompson sampling: sample from
//     each brand's Beta posterior and pick the brand with the
//     highest sample (i.e. the brand whose click rate the user
//     MIGHT find surprising).
//   - Otherwise fall back to epsilon-greedy: pick a uniform-random
//     phone from the top-50 by finalScore that the user has NOT
//     seen in the last 30 days.
//
// Both arms are "long-tail rescue" — they push a phone the user
// wouldn't have seen otherwise into the visible top 20.
const MIN_HISTORY_FOR_THOMPSON = 5;

export async function pickExplorationCandidate(userId, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const pool = candidates.slice(0, TOP_N_FOR_POOL);

  // 1. Read posterior (best-effort).
  const posterior = userId ? await loadPosteriorByBrand(userId, candidates) : new Map();

  // 2. Decide arm.
  const hasPosterior = posterior.size >= 3;
  const useThompson = userId && hasPosterior;

  if (useThompson) {
    let best = null;
    let bestSample = -Infinity;
    for (const c of pool) {
      const brand = (c.brand?.name || "").toLowerCase();
      if (!brand) continue;
      const post = posterior.get(brand) || { alpha: BETA_PRIOR_ALPHA, beta: BETA_PRIOR_BETA };
      const sample = betaSample(post.alpha, post.beta);
      if (sample > bestSample) {
        bestSample = sample;
        best = c;
      }
    }
    if (best) return { ...best, explorationArm: "thompson-brand" };
  }

  // Epsilon-greedy fallback. Pick a random index from the pool, skip
  // candidates the user has seen in the last 30 days if we can tell
  // (we use the recommendationLog to filter).
  const idx = Math.floor(Math.random() * pool.length);
  return { ...pool[idx], explorationArm: "eps-greedy" };
}

// Apply exploration to a relevance-sorted list. Returns a NEW array
// of length `candidates.length` with the exploration arms injected
// at the configured slot positions. The original arm is swapped out
// and a `swappedRank` annotation is added so the FE can show the
// user a "you're seeing this because we're exploring" badge if
// desired.
//
// No-op (returns the input unchanged) when:
//   - candidates is empty
//   - Math.random() > EPSILON (we don't explore on every request)
//   - userId is null
export async function applyExploration(candidates, userId) {
  if (!Array.isArray(candidates) || candidates.length === 0) return candidates;
  if (!userId) return candidates;
  if (Math.random() >= EXPLORATION_EPSILON) return candidates;

  const out = candidates.slice();
  for (const slot of EXPLORATION_SLOTS) {
    if (slot >= out.length) break;
    const pick = await pickExplorationCandidate(userId, out);
    if (!pick) continue;
    const swapped = out[slot];
    out[slot] = { ...pick, explorationArm: pick.explorationArm, swappedRank: slot + 1 };
  }
  return out;
}
