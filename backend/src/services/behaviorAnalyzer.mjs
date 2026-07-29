// behaviorAnalyzer — Step B single source of truth for behaviour events.
//
// Three exports work together:
//   - `recordEvent`   the only thing controllers should call: writes the
//                     `Event` row AND the `BehaviorScore` deltas in one tx.
//   - `extractTagsForEvent`  pure (phone-aware) tag-delta mapper.
//   - `applyDecay`    exponential decay helper for one tag at a time.
//
// Failure policy:
//   `recordEvent` is supposed to be called from the same fire-and-forget
//   helpers that record legacy signals (searchHistory, browsingHistory, …).
//   A throw here must NOT break the user-facing response, so callers wrap
//   the call in try/catch. We still surface the error to the server log so
//   it can be diagnosed post-hoc.
//
// Why a separate service instead of inlining the logic into controllers:
//   - The mapping (event → tags) is the same whether the source is the FE
//     clicking a card or the BE receiving a `safeRecordBrowseEvent`. By
//     centralising here, every incoming event funnels through the same
//     scoring formula. Step C (Profile Fusion) reads from this table.

import { prisma } from "../config/prisma.mjs";

// ---- Delta table ------------------------------------------------------------
//
// Mirrors the README architecture doc §4. Keys are eventTypes; values are
// the tag → delta mapping. Numeric deltas (positive = stronger interest,
// negative = weaker). The actual decay multiplier is `ALPHA` below.
//
// We deliberately keep the taxonomy coarse at this stage: a `phoneId`
// lookup below expands these tags into the specific brand / category /
// tier for that phone.
const DELTAS = {
  search:    { gaming: +2, chipset: +1 },
  compare:   { gaming: +3 },
  view:      { brand: +1, tier: +1 },
  click:     { brand: +2, category: +1 },
  ignore:    { brand: -1, category: -1 },
  save:      { brand: +4, category: +2 },
  recommend: { gaming: +1, category: +1 },
};

// Exponential decay. Each new event contributes delta to the freshly
// decaying score instead of to the score in isolation.
const ALPHA = 0.95;

// ---- Pure helpers ----------------------------------------------------------

// Apply exponential decay + delta to one score. Pure (no I/O).
//
//   score' = score * ALPHA + delta
//
// Inputs:
//   score   — the prior BehaviorScore.score (0 if no row yet)
//   delta   — the contribution from the current event
//   alpha   — decay multiplier; default 0.95 per the architecture doc
//
// Returns the new score, rounded to 4 decimal places to keep the table
// tidy. Callers should clamp to ≥ 0 if they want a strictly positive
// signal (negative interest is allowed so ignore events can pull tags
// back below the neutral line).
export function applyDecay(score, delta, alpha = ALPHA) {
  const s = Number.isFinite(score) ? score : 0;
  const d = Number.isFinite(delta) ? delta : 0;
  const a = Number.isFinite(alpha) ? alpha : ALPHA;
  const next = s * a + d;
  return Math.round(next * 10000) / 10000;
}

// Look up the metadata deltas need for a single phone. Returns null when
// the phoneId is missing or unknown — `extractTagsForEvent` then skips the
// brand / tier / category deltas and emits only the bare-evidence ones.
//
// Cached at module scope for the lifetime of the BE process. Phones don't
// change brand often, so a small Map is plenty.
const phoneMetaCache = new Map();
const PHONE_META_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function lookupPhoneMeta(phoneId) {
  if (!phoneId || typeof phoneId !== "string") return null;
  const cached = phoneMetaCache.get(phoneId);
  const now = Date.now();
  if (cached && now - cached.at < PHONE_META_TTL_MS) {
    return cached.value;
  }
  try {
    const phone = await prisma.phones.findUnique({
      where: { phoneId },
      select: {
        modelName: true,
        antutuScore: true,
        batteryMah: true,
        brand: { select: { name: true } },
        specs: {
          select: { chipset: true },
        },
      },
    });
    if (!phone) {
      phoneMetaCache.set(phoneId, { at: now, value: null });
      return null;
    }
    const value = {
      modelName: phone.modelName || null,
      brandName: phone.brand?.name || null,
      chipset: phone.specs?.chipset || null,
      antutuScore: typeof phone.antutuScore === "number" ? phone.antutuScore : null,
      batteryMah: typeof phone.batteryMah === "number" ? phone.batteryMah : null,
    };
    phoneMetaCache.set(phoneId, { at: now, value });
    return value;
  } catch {
    // Lookup failure is non-fatal — we just skip the phone-derived deltas.
    return null;
  }
}

// Heuristic mapping from free-form search query to tags. We don't run NLP
// here; we grep for category / brand / tier keywords that exist in our
// own seed data and return the matching delta tags.
//
// Keyed lower-case; values are the delta tags they trigger.
const SEARCH_KEYWORDS = {
  // categories
  rog: "gaming",
  gaming: "gaming",
  gamer: "gaming",
  camera: "category:camera",
  photography: "category:camera",
  battery: "category:battery",
  battery_life: "category:battery",
  // tiers / price
  ultra: "tier:flagship",
  flagship: "tier:flagship",
  premium: "tier:flagship",
  budget: "tier:budget",
  midrange: "tier:mid",
  lite: "tier:mid",
  // brands (lower-case)
  apple: "brand:apple",
  iphone: "brand:apple",
  samsung: "brand:samsung",
  galaxy: "brand:samsung",
  xiaomi: "brand:xiaomi",
  redmi: "brand:xiaomi",
  poco: "brand:xiaomi",
  oneplus: "brand:oneplus",
  google: "brand:google",
  pixel: "brand:google",
};

function tagsFromSearchQuery(q) {
  const out = [];
  if (typeof q !== "string") return out;
  const lower = q.toLowerCase();
  for (const [kw, tag] of Object.entries(SEARCH_KEYWORDS)) {
    if (lower.includes(kw)) {
      out.push(tag);
    }
  }
  return out;
}

// Tier inference from a phone's antutu / battery / brand. Used when
// extractTagsForEvent knows the phoneId but not a tier string. Returns
// "flagship" | "mid" | "budget" | null.
function inferTier(meta) {
  if (!meta) return null;
  const antutu = meta.antutuScore;
  if (typeof antutu === "number" && antutu >= 900_000) return "flagship";
  if (typeof antutu === "number" && antutu >= 500_000) return "mid";
  if (typeof antutu === "number") return "budget";
  return null;
}

// Convert a phone's metadata into the concrete `brand:<X>` / `tier:<X>`
// tags (e.g. `brand:Samsung`, `tier:flagship`, `category:camera`) and
// return as `Map<tag, delta>`. The bucket dict is per-event — `view` has
// different deltas than `click` so we pass it in.
function phoneMetaTags(meta, bucket) {
  const out = new Map();
  if (!meta) return out;
  for (const [baseTag, delta] of Object.entries(bucket)) {
    let finalTag = baseTag;
    if (baseTag === "brand" && meta.brandName) {
      const safe = String(meta.brandName).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
      if (!safe) continue;
      finalTag = `brand:${safe}`;
    } else if (baseTag === "tier") {
      const tier = inferTier(meta);
      if (!tier) continue;
      finalTag = `tier:${tier}`;
    } else if (baseTag === "category") {
      // "category" with no qualifier is a generic affinity bump — emit
      // `category:camera` as a stand-in so the tag space stays nameable.
      finalTag = "category:camera";
    }
    out.set(finalTag, (out.get(finalTag) || 0) + delta);
  }
  return out;
}

// ---- Public API ------------------------------------------------------------

// Map an incoming event to the per-tag deltas it should produce. Returns
// a Map<tag, delta>. Pure (modulo the phoneId metadata lookup, which is
// cached so a burst of clicks is cheap).
//
// Recognised eventTypes: "search" | "view" | "compare" | "click" |
// "save" | "ignore" | "recommend". Any other type returns an empty Map —
// caller is free to still log the Event row but no BehaviorScore bump
// happens.
export async function extractTagsForEvent(eventType, phoneId, payload) {
  const bucket = DELTAS[eventType];
  if (!bucket) return new Map();

  let meta = null;
  if (phoneId) {
    meta = await lookupPhoneMeta(phoneId);
  }

  const deltas = new Map();

  // 1. Base deltas from the event type — these include coarse tags like
  //    "gaming" / "chipset". We only emit them when there's evidence
  //    (phoneId-derived meta OR a search query that matches the keyword
  //    table). Otherwise the behaviour-score table would fill up with
  //    noise from background events.
  if (eventType === "search") {
    const tags = tagsFromSearchQuery(payload?.q);
    for (const t of tags) deltas.set(t, (deltas.get(t) || 0) + 1);
  } else if (meta) {
    // For non-search events we trust the phoneId lookup to materialise
    // the right brand / category / tier tags.
    for (const [tag, delta] of phoneMetaTags(meta, bucket)) {
      deltas.set(tag, (deltas.get(tag) || 0) + delta);
    }
    if (eventType === "compare" || eventType === "recommend") {
      // Gaming buckets emit unconditionally for "structural" events that
      // imply the user is comparing/looking at multi-result flows.
      for (const [tag, delta] of Object.entries(bucket)) {
        if (!["brand", "tier", "category"].includes(tag)) {
          deltas.set(tag, (deltas.get(tag) || 0) + delta);
        }
      }
    }
  } else if (eventType === "compare" || eventType === "recommend") {
    // phoneId not supplied (e.g. FE fired compare without IDs yet):
    // still emit the structural deltas.
    for (const [tag, delta] of Object.entries(bucket)) {
      deltas.set(tag, (deltas.get(tag) || 0) + delta);
    }
  }

  return deltas;
}

// The single entry point controllers should use. Writes the Event row
// first (so the audit trail exists), then upserts every tag delta into
// BehaviorScore with exponential decay. All in one transaction — either
// the Event + tag rows exist together or none of them do.
//
// Returns:
//   { eventId, tagsUpdated: string[] }
//
// Throws on DB error; callers wrap in try/catch (fire-and-forget).
export async function recordEvent(userId, eventType, opts = {}) {
  if (!userId) throw new Error("recordEvent requires a userId");
  if (typeof eventType !== "string" || !eventType) {
    throw new Error("recordEvent requires a non-empty eventType");
  }

  const phoneId = typeof opts.phoneId === "string" ? opts.phoneId : null;
  const payload =
    opts.payload && typeof opts.payload === "object" ? opts.payload : null;

  // First pass: derive tags so we can return them in the response. This
  // costs an extra read per call but it's < 1 ms with the cache above.
  const tags = await extractTagsForEvent(eventType, phoneId, payload);
  const tagsUpdated = Array.from(tags.keys());

  return prisma.$transaction(async (tx) => {
    const created = await tx.event.create({
      data: {
        userId,
        eventType,
        phoneId: phoneId || undefined,
        payload: payload || undefined,
      },
      select: { eventId: true },
    });

    for (const [tag, delta] of tags.entries()) {
      // Upsert with raw SQL so we can read-modify-write atomically inside
      // the tx without a separate fetch.
      const existing = await tx.behaviorScore.findUnique({
        where: { userId_tag: { userId, tag } },
        select: { score: true },
      });
      const prev = existing?.score || 0;
      const next = applyDecay(prev, delta);
      await tx.behaviorScore.upsert({
        where: { userId_tag: { userId, tag } },
        create: { userId, tag, score: next },
        update: { score: next },
      });
    }

    return { eventId: created.eventId, tagsUpdated };
  });
}

// Re-export the lookup helper so tests can invalidate the cache.
export const __test__ = { lookupPhoneMeta, phoneMetaCache };
