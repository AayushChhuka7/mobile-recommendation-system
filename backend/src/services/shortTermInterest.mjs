// shortTermInterest — the "recency layer" that makes recommendations
// visibly evolve after every single interaction.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS  (root-cause of the "rankings barely change" problem)
// ---------------------------------------------------------------------------
// The long-term BehaviorScore path is *correct* but *slow to surface*:
//
//   1. score = tanh(0.75 * raw) is deliberately saturating. Once a user
//      has ~4-5 gaming events, feature:gaming is already near +0.95, so
//      the 46th event moves it by ~0.001. The signal flat-lines.
//   2. searchHistoryScore only contributes FUSION_WEIGHTS.search_history
//      = 0.1053 of the final score, and it is centred on a NEUTRAL 0.5.
//      So the entire behaviour signal can only swing the final score by
//      about ±0.05. Two phones whose compatibility/value differ by more
//      than 0.05 can NEVER swap places no matter how many events fire.
//   3. The result: a technically-correct pipeline whose top-5 is frozen.
//
// The fix is NOT "increase the weights" (that makes rankings jumpy and
// destroys accuracy for cold users). The fix is a *second, fast-moving
// interest vector* built only from the user's most recent N events, with
// exponential recency weighting, fed into the ranker as a small additive
// boost. Long-term BehaviorScore stays as the stable base; short-term
// interest supplies the continuous, per-event movement.
//
// This mirrors how large systems separate the two timescales:
//   - Netflix / Amazon: stable collaborative-filtering base + a
//     session/recency re-ranker.
//   - YouTube / TikTok: long-term embedding + a short-term "recent
//     watches" signal that dominates the next-up ordering.
//   - Spotify: long-term taste profile + session-based sequence model.
//
// ---------------------------------------------------------------------------
// ALGORITHM
// ---------------------------------------------------------------------------
// Given the user's last N events (newest first), each event maps to a
// phone, and each phone maps to a feature profile (gaming, camera,
// battery, performance, display) via buildPhoneFeatureProfile.
//
// For event i (i = 0 is newest) with event weight w_e and feature score
// f_dim ∈ [0,1]:
//
//   recencyWeight(i) = DECAY ^ i          (DECAY ∈ (0,1), e.g. 0.85)
//   contribution     = recencyWeight(i) * w_e * f_dim
//
// interest[dim] = Σ_i contribution         (accumulated per dim)
//
// Then L2-normalise interest into a unit vector so the *shape* of recent
// taste matters, not its raw magnitude (magnitude is handled by the
// blend weight in the ranker). This keeps the boost bounded and stable:
// a user who fires 50 gaming events and a user who fires 5 both end up
// with a gaming-dominant unit vector — the difference in confidence is
// carried by how many distinct dims are active, not by unbounded growth.
//
// Because recencyWeight decays geometrically, the newest event always
// carries the largest single weight (DECAY^0 = 1). Adding one event
// shifts the normalised vector by a small but non-zero amount every
// time — which is exactly the "visible movement after every event" the
// UX requires, while the decay guarantees the shift stays smooth.

import { buildPhoneFeatureProfile, FEATURE_DIMS } from "./phoneFeatureProfile.mjs";
import { eventBaseWeight } from "../config/behaviorConfig.mjs";

// Recency decay per event step. 0.85 means the 5th-newest event carries
// ~0.44 of the newest event's weight, the 10th ~0.20, the 20th ~0.04.
// Tunable without touching call sites.
export const SHORT_TERM_DECAY = 0.85;

// How many recent events feed the short-term vector. Beyond ~25 the
// decayed weight is negligible, and it bounds the DB read.
export const SHORT_TERM_WINDOW = 25;

// L2-normalise a Map<dim, number> into a unit vector (same keys). A
// zero vector is returned unchanged so callers can detect "no signal".
function l2Normalise(vec) {
  let sumSq = 0;
  for (const v of vec.values()) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  if (!(norm > 0)) return vec;
  const out = new Map();
  for (const [k, v] of vec.entries()) out.set(k, v / norm);
  return out;
}

// Build the short-term interest unit-vector from recent events.
//
//   events    — [{ eventType, phoneId }] newest-first (from getRecentEvents)
//   metaByPhoneId — Map<phoneId, meta> (from loadPhoneMetaMap)
//
// Returns Map<dim, weight> where Σ weight² = 1 (unit vector), or an
// empty Map when there is no usable recent signal (cold user).
export function buildShortTermInterest(events, metaByPhoneId) {
  const interest = new Map();
  if (!Array.isArray(events) || events.length === 0) return interest;
  const metas =
    metaByPhoneId instanceof Map ? metaByPhoneId : new Map();

  const window = events.slice(0, SHORT_TERM_WINDOW);
  for (let i = 0; i < window.length; i += 1) {
    const ev = window[i];
    if (!ev || typeof ev !== "object") continue;
    const meta = ev.phoneId ? metas.get(ev.phoneId) : null;
    if (!meta) continue;

    const w = eventBaseWeight(ev.eventType);
    if (!(w > 0)) continue;

    const recency = Math.pow(SHORT_TERM_DECAY, i);
    const profile = buildPhoneFeatureProfile(meta);
    for (const [dim, f] of profile.entries()) {
      const add = recency * w * f;
      if (!(add > 0)) continue;
      interest.set(dim, (interest.get(dim) || 0) + add);
    }
  }

  return l2Normalise(interest);
}

// Score a single candidate phone against the short-term interest vector.
// This is a cosine-style dot product between the candidate's feature
// profile (also unit-normalised) and the user's recent-interest unit
// vector → a value in [0, 1] where 1 means "this phone perfectly matches
// what the user just interacted with".
//
//   candidateMeta   — meta for the candidate (from loadPhoneMetaMap)
//   interestVec     — Map<dim, weight> unit vector from buildShortTermInterest
//
// Returns 0 when either side has no signal (neutral — no boost, no
// penalty), so cold-start candidates are never pushed down.
export function shortTermMatch(candidateMeta, interestVec) {
  if (!(interestVec instanceof Map) || interestVec.size === 0) return 0;
  if (!candidateMeta) return 0;

  const profile = l2Normalise(buildPhoneFeatureProfile(candidateMeta));
  if (profile.size === 0) return 0;

  let dot = 0;
  for (const dim of FEATURE_DIMS) {
    const a = profile.get(dim);
    const b = interestVec.get(dim);
    if (a && b) dot += a * b;
  }
  if (dot < 0) return 0;
  if (dot > 1) return 1;
  return dot;
}
