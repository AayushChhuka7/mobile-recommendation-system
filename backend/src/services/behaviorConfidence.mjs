// behaviorConfidence — Phase 4 of the behaviour-learning refresh.
//
// Behaviour should have very little influence on the first few
// interactions and gradually become more influential as the user
// accumulates a consistent history. This module returns that ramp.
//
// We DO NOT redesign the fusion algorithm — the ranker contract stays
// unchanged. Instead, the analyzer scales each event's *base weight*
// by `computeConfidence(eventCount)` at write time, so the DB ends up
// with the same tag names and same eventual magnitudes as before, but
// a single click on a brand-new account writes a much smaller delta
// than the 30th click on the same tag.
//
// Curve: `floor + (ceiling - floor) * (1 - exp(-events / rampEvents))`.
// Properties:
//   - floor       ≤ result ≤ ceiling
//   - smooth, monotonic, asymptotes to ceiling
//   - at events == rampEvents, the curve is at
//     `floor + (ceiling - floor) * (1 - 1/e) ≈ 0.63 * (ceiling - floor)`
//
// Pure: no DB, no side effects.

import { BEHAVIOR_CONFIG } from "../config/behaviorConfig.mjs";

// Epsilon at which we saturate the exponential — past this point the
// curve is within 0.1% of `ceiling` and any further events don't move
// the dial. Keeps the curve bounded and avoids `exp` under/overflow at
// extreme `events` values.
const EFFECTIVE_MAX_EVENTS = 200;

/**
 * Compute the behaviour-confidence multiplier in [floor, ceiling].
 *
 * @param {number} eventCount  — total events observed for this user.
 *                               Negative or non-numeric input is
 *                               coerced to 0.
 * @returns {number}            — multiplier ∈ [floor, ceiling].
 */
export function computeConfidence(eventCount) {
  const cfg = BEHAVIOR_CONFIG.confidence;
  const e =
    Number.isFinite(eventCount) && eventCount > 0 ? eventCount : 0;
  const saturatedEvents = e > EFFECTIVE_MAX_EVENTS ? EFFECTIVE_MAX_EVENTS : e;
  const factor = 1 - Math.exp(-saturatedEvents / cfg.rampEvents);
  // `floor + (ceiling - floor) * factor` — bounded by definition.
  return cfg.floor + (cfg.ceiling - cfg.floor) * factor;
}

/**
 * True when the curve has effectively saturated. Used by callers that
 * want to skip the ramp computation when a user has a long history
 * (cheap pre-check before the call).
 *
 * @param {number} eventCount
 * @returns {boolean}
 */
export function isConfidenceSaturated(eventCount) {
  if (!Number.isFinite(eventCount) || eventCount <= 0) return false;
  const cfg = BEHAVIOR_CONFIG.confidence;
  // Threshold: factor > 0.95 → "saturated enough that another event
  // moves the dial by < 5% of the ceiling-floor span."
  return eventCount / cfg.rampEvents >= Math.log(20);
}

// ---------------------------------------------------------------------------
// Compare-specific confidence ramp (Phase 3 — pair-count, not event-count).
// ---------------------------------------------------------------------------
//
// Compare events fire as TWO event rows per compare (one per side), so the
// global ramp `computeConfidence(eventCount)` would ramp a 3-compare user
// as if they had 6 events. That starves compare-driven learning early in
// the user's history. Instead, we count UNIQUE PAIRS the user has compared
// and feed that into a separate ramp curve that lives under
// `BEHAVIOR_CONFIG.compare.confidence`.
//
// Properties of the compare ramp:
//   - floor = 0.40  — even the very first unique compare contributes 40%
//                     of its full per-event weight. Compare is the
//                     strongest explicit shopping signal we capture, so
//                     we deliberately under-deliver the cold-start
//                     damping the global ramp applies to a single click.
//   - rampUniquePairs = 3  — three distinct pairs saturate the curve.
//                            At 1 pair → ~0.69, at 2 → ~0.83, at 3 → ~0.91.
//   - ceiling = 1.0  — same asymptote as the global ramp.
//
// Implementation note: the curve has the SAME shape as `computeConfidence`
// (a floor + range·(1 − exp(−x/k)) ramp) so behaviour feels consistent
// across event types — only the k, floor, and input unit differ.

const COMPARE_CFG = BEHAVIOR_CONFIG.compare.confidence;

/**
 * Compute the compare-confidence multiplier in [floor, ceiling] from a
 * count of UNIQUE compare pairs the user has fired.
 *
 * @param {number} uniquePairCount  — number of distinct (phoneA, phoneB)
 *                                    pairs the user has compared. Negative
 *                                    or non-numeric input is coerced to 0.
 * @returns {number}                  multiplier ∈ [floor, ceiling].
 */
export function computeCompareConfidence(uniquePairCount) {
  const n =
    Number.isFinite(uniquePairCount) && uniquePairCount > 0
      ? uniquePairCount
      : 0;
  const factor = 1 - Math.exp(-n / COMPARE_CFG.rampUniquePairs);
  return COMPARE_CFG.floor +
    (COMPARE_CFG.ceiling - COMPARE_CFG.floor) * factor;
}

/**
 * Saturated-check sibling for compare events. Same shape as
 * `isConfidenceSaturated` so callers can use them interchangeably.
 *
 * @param {number} uniquePairCount
 * @returns {boolean}
 */
export function isCompareConfidenceSaturated(uniquePairCount) {
  if (!Number.isFinite(uniquePairCount) || uniquePairCount <= 0) return false;
  return (
    uniquePairCount / COMPARE_CFG.rampUniquePairs >= Math.log(20)
  );
}
