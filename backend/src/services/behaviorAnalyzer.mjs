// behaviorAnalyzer — Step B.
//
// Pure functions only. No Prisma / no HTTP. Lives in `services/` because
// the event routes call it on every POST /api/events, but keeping it
// side-effect-free makes it trivially unit-testable and lets the Profile
// Evolution Engine (Step F) replay the same delta logic against an
// in-memory event window.
//
// Pipeline:
//   1. POST /api/events receives an { eventType, phoneId?, payload? }
//   2. The controller calls `tagsForEvent(eventType, phone, payload)`
//      to derive the set of behavioural tags the event affects
//      (e.g. {brand:"ROG", tier:"flagship"}).
//   3. The controller calls `deltasFor(eventType, tags)` to get the
//      signed weight per tag (e.g. {brand: +2}).
//   4. The controller loads the current (userId, tag) → score rows,
//      applies `applyDecay(score, delta)` per tag, and upserts them.
//
// `applyDecay` is the only stateful math; everything else is pure.

// ---- Event taxonomy ----
//
// One canonical, lower-case, kebab-friendly identifier per interaction.
// The FE sends exactly one of these in `eventType`; the analyzer maps
// it to the per-tag deltas below.
//
//   search   — user typed something in the search bar
//   view     — phone card became visible long enough to count
//              (debounced in the FE so it isn't a hover event)
//   click    — user opened the detail page
//   compare  — user added this phone to the compare tray
//   save     — user added this phone to wishlist
//   dismiss  — user explicitly removed a recommendation from the list
//   ignore   — phone was shown to the user but received no interaction
//              for N seconds (the FE fires this on scroll-past)
//
// `unknown` is the catch-all for an eventType the backend doesn't yet
// understand — it returns an empty delta so the event is still logged
// (audit trail) but doesn't pollute the score table.

export const EVENT_TYPES = Object.freeze([
  "search",
  "view",
  "click",
  "compare",
  "save",
  "dismiss",
  "ignore",
]);

// ---- Per-event delta table ----
//
// Each value is the signed weight added to the relevant tag's score
// when the event fires. Magnitudes were chosen so that:
//   - save  > click > view  > search
//   - ignore is mildly negative (a soft signal, not a punishment)
//   - dismiss is the strongest negative (explicit rejection)
//
// Multiple tags can fire for one event — e.g. searching "ROG" lights up
// both `brand` and `chipset` because the user expressed interest in
// both the brand and the gaming-class chipset.

const DELTAS = {
  search:   { brand: +2, chipset: +1 },
  compare:  { gaming: +3 },
  view:     { brand: +1, tier: +1 },
  click:    { brand: +2, category: +1 },
  ignore:   { brand: -1, category: -1 },
  save:     { brand: +4, category: +2 },
  dismiss:  { brand: -3, category: -2 },
};

/**
 * Return the per-tag weight delta for a single event.
 *
 * Unknown event types produce an empty object — the event is still
 * logged in the `events` table for auditing, but the score table is
 * untouched.
 *
 * @param {string} eventType  one of EVENT_TYPES
 * @returns {Record<string, number>}
 */
export const deltasFor = (eventType) => {
  return DELTAS[eventType] ? { ...DELTAS[eventType] } : {};
};

// ---- Decay rule ----
//
// Every new delta is added to the exponentially-decaying current score:
//
//     score_new = score_old * DECAY + delta
//
// DECAY ∈ (0, 1) determines the half-life of interest: with 0.95, a
// user's "save: brand = +4" event loses ~95% of its influence after
// ~log(0.05)/log(0.95) ≈ 58 subsequent other-tag updates. This keeps
// the score responsive to fresh behaviour while preventing a single
// spike from dominating forever.
//
// The function clamps the result to keep scores inside a sane range
// (negative scores are fine — they signal aversion — but we don't
// want float drift after thousands of updates).

const DECAY = 0.95;
const MIN_SCORE = -100;
const MAX_SCORE = 100;

/**
 * Apply one delta to one existing score using the exponential decay rule.
 *
 * Pure: returns a new number, does not mutate inputs.
 *
 * @param {number} prev     current score for the (user, tag) row (0 if absent)
 * @param {number} delta    signed weight from `deltasFor`
 * @returns {number}        clamped new score in [MIN_SCORE, MAX_SCORE]
 */
export const applyDecay = (prev, delta) => {
  const next = prev * DECAY + delta;
  if (next > MAX_SCORE) return MAX_SCORE;
  if (next < MIN_SCORE) return MIN_SCORE;
  return next;
};

/**
 * Apply a full { tag: delta } map to a { tag: score } map.
 * Tags missing from `current` are treated as 0.
 *
 * Returns a new map (no mutation). Used by the event controller to
 * batch-update the BehaviorScore table inside one transaction.
 *
 * @param {Record<string, number>} current
 * @param {Record<string, number>} deltas
 * @returns {Record<string, number>}
 */
export const applyDeltas = (current, deltas) => {
  const out = { ...current };
  for (const [tag, delta] of Object.entries(deltas)) {
    const prev = Number.isFinite(out[tag]) ? out[tag] : 0;
    out[tag] = applyDecay(prev, delta);
  }
  return out;
};

// ---- Tag derivation from a single event ----
//
// Given the event payload + phone context, build the set of behavioural
// tags the event should affect. Tags are intentionally coarse:
//   - brand       — the phone's brand (e.g. "ROG", "Samsung")
//   - chipset     — chip family (e.g. "Snapdragon 8 Gen 3")
//   - tier        — budget/flagship/etc. (derived from price)
//   - category    — gaming/camera/battery (from the phone's dominant trait)
//   - gaming      — explicit gaming-class signal (high AnTuTu etc.)
//
// Anything that can't be derived cleanly is omitted — better to record
// fewer, correct tags than noisy ones.

const TIER_BANDS = [
  { name: "budget",      max: 300 },
  { name: "mid",         max: 600 },
  { name: "premium",     max: 1000 },
  { name: "flagship",    max: Infinity },
];

const tierFromPrice = (price) => {
  const p = Number(price);
  if (!Number.isFinite(p)) return null;
  for (const band of TIER_BANDS) {
    if (p < band.max) return band.name;
  }
  return "flagship";
};

/**
 * Map a chipset name to a behavioural tag family. We only care about
 * the family, not the exact SKU — "Snapdragon 8 Gen 3" and "Snapdragon
 * 8 Gen 2" both express "user likes Snapdragon flagship class".
 *
 * Returns `null` when the chipset string is missing or doesn't match a
 * known family (the caller should drop it from the tag set, not store
 * "unknown" as a tag — that would pollute the score table).
 */
const chipsetFamily = (chipset) => {
  if (!chipset || typeof chipset !== "string") return null;
  const c = chipset.toLowerCase();
  if (c.includes("snapdragon 8") || c.includes("snapdragon 8+")) return "snapdragon-flagship";
  if (c.includes("snapdragon 7")) return "snapdragon-upper-mid";
  if (c.includes("snapdragon")) return "snapdragon";
  if (c.includes("dimensity 9")) return "dimensity-flagship";
  if (c.includes("dimensity 8")) return "dimensity-upper-mid";
  if (c.includes("dimensity")) return "dimensity";
  if (c.includes("apple") || c.includes("a1") || c.includes("a2") || c.includes("a3")) return "apple-silicon";
  if (c.includes("exynos 2")) return "exynos-flagship";
  if (c.includes("exynos")) return "exynos";
  if (c.includes("tensor")) return "google-tensor";
  if (c.includes("kirin")) return "kirin";
  return null;
};

/**
 * Derive the dominant behavioural category for a phone from its specs.
 * Mirrors the persona-style traits the ranker already uses — a phone
 * is "gaming" if its chipset is in the flagship tier AND its AnTuTu is
 * high; "camera" if it has a periscope/very-high-MP main sensor; etc.
 *
 * Returns one of: "gaming", "camera", "battery", "display", or null.
 */
const dominantCategory = (phone) => {
  if (!phone) return null;

  const ram = phone?.variants?.[0]?.ramGb ?? phone?.ramGb ?? null;
  const battery = phone?.batteryMah ?? phone?.specs?.batteryMah ?? null;
  const antutu = phone?.antutuScore ?? null;
  const camera = phone?.specs?.mainCamera ?? phone?.mainCamera ?? null;
  const refresh = phone?.specs?.refreshRate ?? phone?.refreshRate ?? null;

  if ((antutu && antutu >= 900_000) || (ram && ram >= 12 && refresh && refresh >= 120)) {
    return "gaming";
  }
  if (camera && typeof camera === "string" && /periscope|\b200\b|\b108\b|\b50\b.*\b50\b/i.test(camera)) {
    return "camera";
  }
  if (battery && battery >= 5500) {
    return "battery";
  }
  if (refresh && refresh >= 120) {
    return "display";
  }
  return null;
};

/**
 * Build the tag set for a single event. Returns a `Set<string>` of
 * non-null, deduplicated tags.
 *
 *   tagsForEvent("save", phone, { query: "ROG" })
 *     → Set { "brand:ROG", "tier:flagship", "category:gaming" }
 *
 * Tag format: "<dimension>:<value>". The dimension prefix lets us
 * namespace and filter ("all `brand:*` rows", "all `category:*` rows")
 * when computing the search-history score downstream.
 *
 * @param {string} eventType
 * @param {object|null} phone   enriched phone object (may be null for
 *                              eventTypes like `search` that don't pin
 *                              a specific phone — the FE sends the
 *                              query in `payload` instead).
 * @param {object|null} payload event payload (e.g. { query, position })
 * @returns {Set<string>}
 */
export const tagsForEvent = (eventType, phone, payload) => {
  const tags = new Set();

  if (phone) {
    const brand =
      phone?.brand?.name ??
      (typeof phone?.brand === "string" ? phone.brand : null);
    if (brand) tags.add(`brand:${brand}`);

    const price =
      phone?.cheapestVariant?.price ??
      phone?.variants?.[0]?.price ??
      phone?.price ??
      null;
    const tier = tierFromPrice(price);
    if (tier) tags.add(`tier:${tier}`);

    const chip =
      phone?.specs?.chipset ?? phone?.chipset ?? null;
    const family = chipsetFamily(chip);
    if (family) tags.add(`chipset:${family}`);

    const cat = dominantCategory(phone);
    if (cat) tags.add(`category:${cat}`);
  }

  // For `search`, the query string itself is a strong brand/category
  // signal — extract anything that looks like a brand token from it
  // and add it as a `brand` tag even when no phone is pinned.
  if (eventType === "search" && payload && typeof payload.query === "string") {
    const q = payload.query.trim();
    if (q.length > 0 && q.length <= 60) {
      // Lower-case the whole query as a single token — phones rarely
      // collide in search ("rog" almost always means the brand).
      tags.add(`query:${q.toLowerCase()}`);
    }
  }

  return tags;
};

/**
 * Strip the `<dimension>:` prefix and return just the values. Useful
 * when the caller wants to display top tags in the FE.
 *
 *   splitTags(Set{"brand:ROG", "tier:flagship"})
 *     → { brand: ["ROG"], tier: ["flagship"] }
 */
export const splitTags = (tagSet) => {
  const out = {};
  for (const tag of tagSet) {
    const idx = tag.indexOf(":");
    if (idx < 0) continue;
    const dim = tag.slice(0, idx);
    const value = tag.slice(idx + 1);
    if (!out[dim]) out[dim] = [];
    out[dim].push(value);
  }
  return out;
};