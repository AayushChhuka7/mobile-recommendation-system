// behaviorConfig — single source of truth for every behaviour-learning
// constant. Phase 0 of the behaviour-learning refresh.
//
// Before this file existed, every magic number lived inline in
// `behaviorAnalyzer.mjs` (e.g. `ALPHA = 0.95`, `DELTAS.view = { _base: 1.0 }`).
// Tuning any one of them required a code change in a hot path. By
// collecting them here we make the system observable at runtime — the
// analyser imports this object once and reads from it.
//
// All exports are frozen so consumers cannot mutate the configuration
// at runtime. Tests and ops dashboards can `import { BEHAVIOR_CONFIG }`
// to inspect the live values without changing behaviour.
//
// Public exports:
//   BEHAVIOR_CONFIG     — the frozen config object
//   eventBaseWeight()   — safe lookup with default fallback
//   featureBaseWeight() — safe lookup with default fallback

// ---- Per-event weights -----------------------------------------------------
//
// Smaller absolute weight = weaker signal. These are tuned so a single
// recommend call produces roughly 7-8x the score movement of a single
// view, matching the brief's "compare > search > click > view" intent.
//
// All values are positive = interest, negative = dislike. Values are
// intentionally tight (max ≈ 3.0) because the per-event confidence ramp
// (below) multiplies them and we want the post-ramp weights to remain
// in the same order of magnitude as the previous DELTAS table.
export const BEHAVIOR_CONFIG = Object.freeze({
  eventWeights: Object.freeze({
    view:      0.40,   // glancing at a card — very light
    click:     0.65,   // opened the detail page
    search:    0.90,   // typed a query — explicit intent
    compare:   2.00,   // side-by-side comparison — strong shopping intent
    recommend: 3.00,   // "Recommend Me" button — strongest explicit ask
    save:      2.40,   // bookmarked
    ignore:   -0.55,   // dismissed / scrolled past
  }),

  // Per-dim importance multiplier. Different features matter to
  // different users; these constants let us bias the feature vector
  // toward the dims this product considers "heavier" without baking
  // the bias into the per-phone feature profile.
  featureWeight: Object.freeze({
    gaming:       1.00,
    camera:       0.85,
    battery:      0.70,
    performance:  0.90,
    display:      0.55,
    brand:        0.60,  // used when emitting brand:<X> bumps
    tier:         0.40,
  }),

  // Score bounds. The `applyDecay` helper reads these every event.
  // `positiveCap` is the asymptote of positive scores; `negativeFloor`
  // is the asymptote of negative scores (always present so ignore /
  // dismiss events can't over-penalise a tag below the neutral line).
  score: Object.freeze({
    alpha: 0.93,            // exponential decay multiplier per event
    positiveCap: 4.0,       // tanh saturates near here at ~95% of cap
    negativeFloor: -2.0,    // ignore / dismiss asymptote
    saturationTanhK: 0.6,   // tanh(K * raw) ∈ (−1, 1)
  }),

  // Diminishing returns on repeats of the same (userId, eventType,
  // phoneId) tuple. multiplier(n) = initial / (1 + curveK * (n-1)).
  // For curveK = 0.55: 1.000, 0.645, 0.476, 0.385, 0.323 — gentle
  // enough that a few intentional repeats still register, steep
  // enough that a runaway click loop cannot pump scores infinitely.
  repeats: Object.freeze({
    initial: 1.0,
    curveK: 0.55,
  }),

  // Behaviour-confidence ramp. Controls how much each individual
  // event contributes as the user's history grows. With these
  // defaults: 0 events → 0.15, 5 events → 0.42, 12 events → 0.66,
  // 30 events → 0.93. A single click therefore writes a tiny bump
  // (~0.06) and only after dozens of events does each click write
  // its full base weight.
  //
  // Implementation note: we multiply the per-event base weight inside
  // `behaviorAnalyzer.recordEvent`, not the score at read time, so
  // legacy rows in `BehaviorScore` are left untouched.
  confidence: Object.freeze({
    rampEvents: 12,
    floor: 0.15,
    ceiling: 1.0,
  }),

  // Per-tag recent-reason tracker (Phase 6 — explainability). Each
  // BehaviorScore row carries an LRU of the last N events that
  // nudged its score, so the FE can render "Boosted by your activity
  // → Gaming +1 (compared RedMagic 10 Pro)".
  reasons: Object.freeze({
    perTagLimit: 5,
  }),

  // Event-dedup: hard-deduplicate repeats inside this window so a
  // double-click doesn't write two audit rows. Events outside the
  // window are kept, just with diminishing weight (see `repeats`
  // above + `diminishingMultiplier`).
  events: Object.freeze({
    dedupWindowMs: 30 * 1000,
    dedupableTypes: Object.freeze([
      "click",
      "view",
      "compare",
      "save",
    ]),
  }),

  // Phone-feature-profile builder thresholds. These are intentionally
  // gentle — any phone that exceeds the lowest bar still receives a
  // non-zero score for the dim. Thresholds live here (not inside the
  // builder) so future tuning is one file edit, not a code change.
  featureThresholds: Object.freeze({
    gaming: Object.freeze({
      chipsetBoost: 0.7,
      refreshBoost: 0.2,
      refreshMinHz: 120,
      antutuBoost: 0.1,
      antutuMin: 800_000,
    }),
    camera: Object.freeze({
      tiers: Object.freeze([
        { minMp: 48, score: 1.0 },
        { minMp: 24, score: 0.6 },
        { minMp: 12, score: 0.3 },
      ]),
    }),
    battery: Object.freeze({
      tiers: Object.freeze([
        { minMah: 5500, score: 1.0 },
        { minMah: 5000, score: 0.8 },
        { minMah: 4500, score: 0.5 },
        { minMah: 4000, score: 0.2 },
      ]),
    }),
    performance: Object.freeze({
      tiers: Object.freeze([
        { minAnutu: 1_000_000, score: 1.0 },
        { minAnutu: 700_000,   score: 0.7 },
        { minAnutu: 400_000,   score: 0.4 },
      ]),
    }),
    display: Object.freeze({
      refreshBoost: 0.6,
      refreshMinHz: 120,
      sizeBoost: 0.4,
      sizeMinInches: 6.5,
    }),
  }),
});

// ---- Lookup helpers --------------------------------------------------------

// Safe read for `BEHAVIOR_CONFIG.eventWeights[type]`. Returns 0 when
// the type is unknown so unknown events become a true no-op rather
// than throwing or slipping through with an undefined delta.
export function eventBaseWeight(eventType) {
  if (typeof eventType !== "string") return 0;
  const w = BEHAVIOR_CONFIG.eventWeights[eventType];
  return Number.isFinite(w) ? w : 0;
}

// Safe read for `BEHAVIOR_CONFIG.featureWeight[dim]`. Returns 0 for
// unknown dims so a typo in the feature-name string fails closed.
export function featureBaseWeight(dim) {
  if (typeof dim !== "string") return 0;
  const w = BEHAVIOR_CONFIG.featureWeight[dim];
  return Number.isFinite(w) ? w : 0;
}
