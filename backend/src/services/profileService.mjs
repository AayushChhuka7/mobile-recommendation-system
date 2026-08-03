// profileService — single owner of reads/writes against the customer-
// profile tables (UserPreference, CustomerProfile, SearchHistory,
// BrowsingHistory, RecommendationHistory, ComparisonHistory).
//
// Every implicit-signal write from controllers (search, browse, recommend,
// compare) and every explicit-signal write from the new self-service
// endpoints funnels through here, so the controllers never touch the
// profile tables directly.
//
// Step B bridge:
//   The four `safeRecord*` wrappers below additionally call
//   `behaviorAnalyzer.recordEvent` so the new unified `Event` log and
//   per-tag `BehaviorScore` rows stay in sync with the legacy tables.
//   The legacy tables remain written-to so the existing admin UI and
//   dashboards continue to work. Failures in the analyzer are swallowed
//   in the same fire-and-forget style as the rest of this file so a
//   behaviour-score write can never break the user-facing response.
//
// Failure policy: controllers call these helpers from `catchAsync`-wrapped
// routes. If a profile write throws here (e.g. transient DB error), the
// error bubbles up and the global errorHandler responds with 500 — but
// the high-level endpoints that own implicit signals swallow those
// exceptions (see `safeRecord*` wrappers below) so analytics failures can
// never abort a successful phone listing or recommendation response.

import { prisma } from "../config/prisma.mjs";
import { recordEvent as recordBehaviorEvent } from "./behaviorAnalyzer.mjs";
import { safeAggregateAfterRecommendation } from "./profileAggregator.mjs";
import { phoneMetaFromRow } from "./phoneFeatureProfile.mjs";


// ---------------------------------------------------------------------------
// Domain mappings — FE persona/weight payload → DB enums/counters
// ---------------------------------------------------------------------------

// Map the FE persona category to the UserPreference.usageType enum.
// The persona categories come from `CATEGORY_OPTIONS` in Dashboard.jsx:
//   "gamer" | "camera" | "battery" | "allrounder" | "Custom"
// Weights-touched turns the persona into "Custom" at save time (see FE).
export const PERSONA_TO_USAGE_TYPE = {
  gamer: "Gamer",
  camera: "Creator",
  battery: "Casual",
  allrounder: "Casual",
  Custom: "Casual",
};

// Map FE persona to cameraPreference enum. Only two states make sense
// from a one-shot signal: the camera slider is at the top (Photophile)
// or it isn't (Sensible). SelfieAddict would require front-camera
// signals we don't have yet — do not invent them.
export const deriveCameraPreference = (weights) => {
  const w = weights && typeof weights.camera === "number" ? weights.camera : 0;
  return w >= 4 ? "Photophile" : "Sensible";
};

// Map the user's `maxBudget` to the BudgetSegment enum. These thresholds
// line up with the existing enum names (Budget Explorer / Affordable /
// Mid Range / Premium / Luxury).
export const deriveBudgetSegment = (maxBudget) => {
  const v = Number(maxBudget);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v <= 150) return "BudgetExplorer";
  if (v <= 300) return "AffordableBuyer";
  if (v <= 600) return "MidRangeBuyer";
  if (v <= 1000) return "PremiumBuyer";
  return "LuxuryBuyer";
};

// Allowed persona values for explicit persistence. Mirrors the FE's
// CATEGORY_OPTIONS + the implicit "Custom" produced when the user
// touches the weight sliders.
export const ALLOWED_PERSONAS = new Set([
  "gamer",
  "camera",
  "battery",
  "allrounder",
  "Custom",
]);

// Allowed sort values for filter-preset persistence. Mirrors Dashboard's
// SORT_OPTIONS.
const ALLOWED_SORTS = new Set([
  "newest",
  "oldest",
  "name_asc",
  "name_desc",
  "price_asc",
  "price_desc",
  "antutu",
]);

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

// Format the FE payload { persona, weights, budgetMin, budgetMax } into
// the columns we actually persist. Returns null if the payload is empty.
const buildExplicitPreference = (payload) => {
  if (!payload || typeof payload !== "object") return null;

  const persona = typeof payload.persona === "string" ? payload.persona : null;
  const validPersona = persona && ALLOWED_PERSONAS.has(persona) ? persona : null;
  const weights =
    payload.weights && typeof payload.weights === "object" ? payload.weights : null;

  const usageType = validPersona
    ? PERSONA_TO_USAGE_TYPE[validPersona] || "Casual"
    : null;
  const cameraPreference = deriveCameraPreference(weights);

  // budgetMax is the only required field on the FE side; budgetMin is
  // optional. Both must be positive numbers.
  const maxRaw = payload.budgetMax;
  const max =
    maxRaw === "" || maxRaw === null || maxRaw === undefined
      ? null
      : Number(maxRaw);
  const minRaw = payload.budgetMin;
  const min =
    minRaw === "" || minRaw === null || minRaw === undefined
      ? null
      : Number(minRaw);

  return {
    persona: validPersona, // stored back into CustomerProfile.recommendationPersona
    usageType, // UserPreference.usageType enum (nullable if no persona)
    cameraPreference, // UserPreference.cameraPreference enum (always one of two)
    maxBudget: Number.isFinite(max) && max > 0 ? max : null,
    minBudget:
      Number.isFinite(min) && min >= 0 ? min : null, // tracked via avgBudget later
  };
};

// Allowed key whitelist for persisted filters. Anything else is dropped
// silently — the FE evolves and we don't want a stale key in the saved
// preset to crash an upsert.
const ALLOWED_FILTER_KEYS = [
  "brand",
  "minPrice",
  "maxPrice",
  "minRam",
  "minBattery",
  "os",
  "has5G",
  "hasNfc",
  "hasOis",
];

const buildFilterPreset = (payload) => {
  const out = { filters: {}, sort: null };
  if (payload && typeof payload === "object") {
    const f = payload.filters && typeof payload.filters === "object" ? payload.filters : {};
    for (const key of ALLOWED_FILTER_KEYS) {
      if (key in f) {
        out.filters[key] = f[key];
      }
    }
    if (typeof payload.sort === "string" && ALLOWED_SORTS.has(payload.sort)) {
      out.sort = payload.sort;
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Self-service bundle — the shape that hydrates the FE on Dashboard mount
// ---------------------------------------------------------------------------

export const getProfileBundle = async (userId) => {
  const userIdWhere = userId;

  const [
    preference,
    customerProfile,
    lastCall,
    lastSearches,
    lastBrowses,
    lastComparisons,
    user,
  ] = await Promise.all([
    prisma.userPreference.findUnique({
      where: { userId: userIdWhere },
    }),
    prisma.customerProfile.findUnique({
      where: { userId: userIdWhere },
    }),
    // Most-recent per-call snapshot — already carries the top-3 phones
    // resolved to { phoneId, modelName, brand, rank, score }. This is
    // a single row, so the join cost is one PK lookup.
    prisma.recommendationCall.findFirst({
      where: { userId: userIdWhere },
      orderBy: { servedAt: "desc" },
    }),
    // Last 5 searches — the bundle used to be sliced at 20, but the
    // admin panel only renders 5 so we tighten the read here.
    prisma.searchHistory.findMany({
      where: { userId: userIdWhere },
      orderBy: { searchedAt: "desc" },
      take: 5,
      select: {
        searchId: true,
        searchQuery: true,
        searchedAt: true,
      },
    }),
    // Last 10 unique browses. The insert-time dedup in
    // `safeRecordBrowseEvent` already keeps the rolling window at 10
    // unique phones, but we read a wider slice and apply a last-mile
    // dedup so legacy rows (pre-dedup duplicates) can't slip through.
    prisma.browsingHistory.findMany({
      where: { userId: userIdWhere },
      orderBy: { viewedAt: "desc" },
      take: BROWSE_HISTORY_PAST_WINDOW,
      select: {
        browsingId: true,
        phoneLabel: true,
        phoneId: true,
        brandName: true,
        viewedAt: true,
      },
    }),
    // Last 5 comparisons. The two phoneIds in each row get resolved to
    // { phoneId, modelName, brand } below so the admin panel can render
    // "Brand Model vs Brand Model".
    prisma.comparisonHistory.findMany({
      where: { userId: userIdWhere },
      orderBy: { comparedDate: "desc" },
      take: 5,
      select: {
        comparisonId: true,
        comparedDate: true,
        phoneIdA: true,
        phoneIdB: true,
      },
    }),
    prisma.users.findUnique({
      where: { userId: userIdWhere },
      select: {
        userId: true,
        name: true,
        email: true,
        phoneNo: true,
        isActive: true,
        isVerified: true,
        role: { select: { roleId: true, roleName: true } },
      },
    }),
  ]);

  // Resolve phoneIds for the comparisons list in one query so we
  // don't N+1 each row.
  const comparisonPhoneIds = Array.from(
    new Set(
      lastComparisons
        .flatMap((c) => [c.phoneIdA, c.phoneIdB])
        .filter(Boolean),
    ),
  );
  const phoneLookup =
    comparisonPhoneIds.length > 0
      ? await prisma.phones.findMany({
          where: { phoneId: { in: comparisonPhoneIds } },
          select: {
            phoneId: true,
            modelName: true,
            brand: { select: { name: true } },
          },
        })
      : [];
  const phoneMap = new Map(
    phoneLookup.map((p) => [p.phoneId, p]),
  );

  // Shape the per-call recommendation snapshot. The `topResults` JSON
  // column already carries the resolved `modelName` + `brand` per entry;
  // we don't need to re-join Phones here.
  const lastRecommendation = lastCall
    ? {
        persona: lastCall.persona || null,
        budget: lastCall.budget || null,
        servedAt: lastCall.servedAt,
        topResults: Array.isArray(lastCall.topResults)
          ? lastCall.topResults.map((r) => ({
              phoneId: r.phoneId || null,
              modelName: r.modelName || null,
              brand: r.brand || null,
              rank: Number.isFinite(Number(r.rank)) ? Number(r.rank) : null,
              score: Number.isFinite(Number(r.score)) ? Number(r.score) : null,
            }))
          : [],
      }
    : null;

  return {
    user: user
      ? {
          userId: user.userId,
          name: user.name,
          email: user.email,
          phoneNo: user.phoneNo || null,
          isActive: user.isActive,
          isVerified: user.isVerified,
          role: user.role?.roleName || null,
        }
      : null,
    preference: preference
      ? {
          maxBudget: preference.maxBudget
            ? Number(preference.maxBudget.toString())
            : null,
          cameraPreference: preference.cameraPreference,
          usageType: preference.usageType,
          preferredBrands: Array.isArray(preference.preferredBrands)
            ? preference.preferredBrands
            : null,
        }
      : null,
    customerProfile: customerProfile
      ? {
          budgetSegment: customerProfile.budgetSegment,
          techTier: customerProfile.techTier,
          recommendationPersona: customerProfile.recommendationPersona,
          avgBudget: customerProfile.avgBudget
            ? Number(customerProfile.avgBudget.toString())
            : null,
          // preferredRamGb / preferredStorageGb are populated by the
          // profile aggregator (backend/src/workers/profileAggregatorWorker)
          // from the user's last 25 recommendation rows. We expose
          // them as plain integers so the FE can render "8 GB" / "128
          // GB" without further processing.
          preferredRamGb: customerProfile.preferredRamGb ?? null,
          preferredStorageGb: customerProfile.preferredStorageGb ?? null,
          searchCount: customerProfile.searchCount,
          totalRecommendations: customerProfile.totalRecommendations,
          totalComparisons: customerProfile.totalComparisons,
          segmentConfidence: customerProfile.segmentConfidence,
          lastUpdated: customerProfile.lastUpdated,
        }
      : null,
    lastRecommendation,
    lastSearches: lastSearches.map((s) => ({
      searchQuery: s.searchQuery,
      searchedAt: s.searchedAt,
    })),
    lastBrowses: (() => {
      // Final-mile dedup: key on phoneId when present, fall back to
      // lower-cased phoneLabel. The list is already sorted viewedAt
      // DESC, so the first occurrence is the most recent — preserve
      // the most-recent timestamp too.
      const seen = new Set();
      const out = [];
      for (const b of lastBrowses) {
        const key =
          (b.phoneId && b.phoneId) ||
          (b.phoneLabel && b.phoneLabel.toLowerCase()) ||
          b.browsingId;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          phoneLabel: b.phoneLabel,
          brandName: b.brandName,
          viewedAt: b.viewedAt,
        });
        if (out.length === BROWSE_HISTORY_LIMIT) break;
      }
      return out;
    })(),
    lastComparisons: lastComparisons.map((c) => {
      const a = phoneMap.get(c.phoneIdA);
      const b = phoneMap.get(c.phoneIdB);
      return {
        comparedDate: c.comparedDate,
        phoneA: {
          phoneId: c.phoneIdA,
          modelName: a?.modelName || null,
          brand: a?.brand?.name || null,
        },
        phoneB: {
          phoneId: c.phoneIdB,
          modelName: b?.modelName || null,
          brand: b?.brand?.name || null,
        },
      };
    }),
  };
};

// ---------------------------------------------------------------------------
// Explicit preferences — "Recommend Me a Phone" modal
// ---------------------------------------------------------------------------

// Persist the user's last-used persona + weights + budget. Upserts both
// UserPreference and CustomerProfile in a single transaction so the two
// rows can never drift.
export const saveExplicitPreferences = async (userId, payload) => {
  const shaped = buildExplicitPreference(payload);

  return prisma.$transaction(async (tx) => {
    // 1. UserPreference row (one-to-one with user)
    if (shaped && (shaped.usageType || shaped.maxBudget !== null)) {
      await tx.userPreference.upsert({
        where: { userId },
        create: {
          userId,
          maxBudget: shaped.maxBudget ?? 0,
          cameraPreference: shaped.cameraPreference,
          usageType: shaped.usageType || "Casual",
        },
        update: {
          ...(shaped.maxBudget !== null ? { maxBudget: shaped.maxBudget } : {}),
          cameraPreference: shaped.cameraPreference,
          ...(shaped.usageType ? { usageType: shaped.usageType } : {}),
        },
      });
    }

    // 2. CustomerProfile row (one-to-one with user)
    const existing = await tx.customerProfile.findUnique({
      where: { userId },
    });

    const newSegment =
      shaped && shaped.maxBudget !== null
        ? deriveBudgetSegment(shaped.maxBudget)
        : existing?.budgetSegment || null;

    const next = {
      ...(newSegment ? { budgetSegment: newSegment } : {}),
      ...(shaped && shaped.persona
        ? { recommendationPersona: shaped.persona }
        : {}),
      ...(shaped && shaped.cameraPreference
        ? { cameraPreference: shaped.cameraPreference }
        : {}),
    };

    // Touch avgBudget as a rolling value: keep the prior average if we
    // already had one, otherwise seed it with the new max. The "rolling
    // mean" integration gets computed in a future step; for now we
    // simply preserve the prior history.
    if (shaped && shaped.maxBudget !== null) {
      const prior = existing?.avgBudget ? Number(existing.avgBudget.toString()) : null;
      next.avgBudget = prior !== null ? prior : shaped.maxBudget;
    }

    // Promote provisional → confirmed as soon as we've seen at least one
    // explicit preference write.
    if (!existing) {
      next.segmentConfidence = "confirmed";
    }

    await tx.customerProfile.upsert({
      where: { userId },
      create: {
        userId,
        ...next,
      },
      update: next,
    });

    return { ok: true };
  });
};

// Persist the user's last-used listing filters and sort order. We don't
// have a dedicated table for this, so the JSON column on UserPreference
// (`preferredBrands`) is doubled-up with a small JSON-friendly field —
// but the cleanest path is to use the same `CustomerProfile.recommendationPersona`
// slot... no wait, that's already used. Instead we reuse a pattern: the
// filter preset lives in `preferredBrands` as a JSON object (keyed shape)
// so admins reading the bundle can see what filters the customer most
// recently applied.
//
// Tradeoff: this slightly overloads the column. The other option was a
// brand-new `UserFilterPreset` table; we picked the lighter touch for
// step-A. The shape is tag-guarded with `__kind: "filter-preset"` so
// it's distinguishable from a normal array of brand names.
export const saveFilterPreset = async (userId, payload) => {
  const shaped = buildFilterPreset(payload);

  await prisma.userPreference.upsert({
    where: { userId },
    create: {
      userId,
      maxBudget: 0,
      cameraPreference: "Sensible",
      usageType: "Casual",
      preferredBrands: {
        __kind: "filter-preset",
        filters: shaped.filters,
        sort: shaped.sort,
        savedAt: new Date().toISOString(),
      },
    },
    update: {
      preferredBrands: {
        __kind: "filter-preset",
        filters: shaped.filters,
        sort: shaped.sort,
        savedAt: new Date().toISOString(),
      },
    },
  });

  // Bump searchCount so admins can see the user is engaged.
  await prisma.customerProfile.upsert({
    where: { userId },
    create: { userId, searchCount: 1 },
    update: { searchCount: { increment: 1 } },
  });

  return { ok: true };
};

// Read the saved filter preset back out in the same shape the FE expects.
export const getFilterPreset = async (userId) => {
  const row = await prisma.userPreference.findUnique({
    where: { userId },
    select: { preferredBrands: true },
  });
  const raw = row?.preferredBrands;
  // Defensive shape check; older rows may be a plain brand array.
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    raw.__kind === "filter-preset"
  ) {
    return {
      filters: raw.filters || {},
      sort: raw.sort || null,
      savedAt: raw.savedAt || null,
    };
  }
  return { filters: {}, sort: null, savedAt: null };
};

// Read the explicit preference row into the shape FE pre-fills.
export const getExplicitPreferences = async (userId) => {
  const [pref, cust] = await Promise.all([
    prisma.userPreference.findUnique({ where: { userId } }),
    prisma.customerProfile.findUnique({ where: { userId } }),
  ]);

  if (!pref && !cust) return null;

  return {
    persona: cust?.recommendationPersona || null,
    budgetMin: null, // FE doesn't currently persist min budget separately; reserved
    budgetMax: pref?.maxBudget ? Number(pref.maxBudget.toString()) : null,
    usageType: pref?.usageType || null,
    cameraPreference: pref?.cameraPreference || null,
    budgetSegment: cust?.budgetSegment || null,
    segmentConfidence: cust?.segmentConfidence || null,
  };
};

// ---------------------------------------------------------------------------
// Implicit signals — fire-and-forget wrappers used by other controllers
// ---------------------------------------------------------------------------

// Fire-and-forget helper for the Step B behavior analyzer. Wraps the call
// in try/catch so a failure in the new event log can never break the
// existing legacy write above. Lives at the same level as the
// safeRecord*Event wrappers it complements — kept in this file because
// the wiring is purely a Step B concern about *this* service, not a
// generalisation of the analyzer.
const safeRecordBehaviorEvent = async (userId, eventType, opts) => {
  if (!userId) return;
  try {
    await recordBehaviorEvent(userId, eventType, opts || {});
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[profile] behaviorAnalyzer.recordEvent failed:",
        err?.message || err,
      );
    } else {
      console.error("[profile] behaviorAnalyzer.recordEvent failed:", err);
    }
  }
};

// Record a search event. Either a typed query string OR a filter snapshot
// (or both). Saved to SearchHistory. Bumps CustomerProfile.searchCount.
export const safeRecordSearchEvent = async (userId, { searchQuery = null, filtersJson = null }) => {
  if (!userId) return;
  try {
    const label =
      (typeof searchQuery === "string" && searchQuery.trim().length > 0
        ? searchQuery.trim()
        : null) ||
      (filtersJson ? JSON.stringify(filtersJson) : null) ||
      "search";

    await prisma.$transaction(async (tx) => {
      await tx.searchHistory.create({
        data: {
          userId,
          searchQuery: label.slice(0, 200),
          searchedAt: new Date(),
        },
      });
      await tx.customerProfile.upsert({
        where: { userId },
        create: { userId, searchCount: 1 },
        update: { searchCount: { increment: 1 } },
      });
    });
  } catch (err) {
    // Analytics writes must never break the user-facing request. Log and
    // continue. In dev we want the full error; in prod we shrink to a
    // one-liner so we don't leak DB internals.
    if (process.env.NODE_ENV === "production") {
      console.warn("[profile] recordSearchEvent failed:", err?.message || err);
    } else {
      console.error("[profile] recordSearchEvent failed:", err);
    }
  }

  // Step B — also log the search into the unified event log so the per-tag
  // BehaviourScore sees gaming/chipset/brand interest over time.
  // We let the analyzer derive tags from the query string itself; the
  // phoneId is unknown at search-time so we leave it null.
  const trimmedQuery =
    typeof searchQuery === "string" && searchQuery.trim().length > 0
      ? searchQuery.trim()
      : null;
  await safeRecordBehaviorEvent(userId, "search", {
    payload: {
      q: trimmedQuery || null,
      filters: filtersJson && typeof filtersJson === "object" ? filtersJson : null,
    },
  });
};

// How many unique phones we keep in BrowsingHistory per user. The
// latest 10 phones the user touched is the only "long-tail" signal we
// surface — anything older is never displayed and never feeds scoring,
// so we trim it as a rolling cap. We read slightly more (PAST_WINDOW)
// so a duplicate check can see the full rolling window.
const BROWSE_HISTORY_LIMIT = 10;
const BROWSE_HISTORY_PAST_WINDOW = 30;

// Decide whether a new (userId, phoneLabel / phoneId) browse event is
// a duplicate of one already in the user's rolling window. We dedup on
// `phoneLabel` when both this and the most recent row have a non-empty
// label, and fall back to `phoneId` when the label is missing (the
// legacy "Brand · Model" label is the human-readable fingerprint the
// admin sees, so that's the right key for the dedup).
//
// Returns true if the resulting row would re-track a phoneId already
// in the last `BROWSE_HISTORY_LIMIT` unique phones — the caller uses
// that to skip both the BrowsingHistory insert AND the Step B
// BehaviorScore bump.
async function isDuplicateBrowse(userId, phoneLabel, phoneId) {
  if (!userId) return true;
  const lookupLabel =
    typeof phoneLabel === "string" && phoneLabel.trim().length > 0
      ? phoneLabel.trim().toLowerCase()
      : null;
  const lookupId =
    typeof phoneId === "string" && phoneId.length > 0 ? phoneId : null;

  // No usable key at all (no label + no phoneId) — let the row through
  // so we don't accidentally drop a real event. The legacy callers
  // always supply a phoneLabel, so this is just defence-in-depth.
  if (!lookupLabel && !lookupId) return false;

  try {
    const recent = await prisma.browsingHistory.findMany({
      where: { userId },
      orderBy: { viewedAt: "desc" },
      take: BROWSE_HISTORY_PAST_WINDOW,
      select: { phoneLabel: true, phoneId: true },
    });
    if (!recent || recent.length === 0) return false;
    for (const row of recent) {
      if (lookupId && row.phoneId && row.phoneId === lookupId) return true;
      if (
        lookupLabel &&
        row.phoneLabel &&
        row.phoneLabel.toLowerCase() === lookupLabel
      ) {
        return true;
      }
    }
    return false;
  } catch (err) {
    // On a read failure we err toward *not* dedup'd so the event still
    // records. The worst case is one extra row, not lost data.
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[profile] isDuplicateBrowse read failed:",
        err?.message || err,
      );
    } else {
      console.warn("[profile] isDuplicateBrowse read failed:", err);
    }
    return false;
  }
}

// After a successful insert, prune the user's BrowsingHistory back to
// the last `BROWSE_HISTORY_LIMIT` *unique* phones. We dedup by the same
// key (phoneLabel first, phoneId as fallback) so a row that somehow
// slipped through the insert-time check still gets the rolling cap.
async function pruneBrowsingHistoryToLimit(userId) {
  if (!userId) return;
  try {
    const rows = await prisma.browsingHistory.findMany({
      where: { userId },
      orderBy: { viewedAt: "desc" },
      take: BROWSE_HISTORY_PAST_WINDOW * 2,
      select: { browsingId: true, phoneLabel: true, phoneId: true, viewedAt: true },
    });
    if (!rows || rows.length <= BROWSE_HISTORY_LIMIT) return;

    const seen = new Set();
    const survivors = [];
    for (const row of rows) {
      const key =
        (row.phoneLabel && row.phoneLabel.toLowerCase()) ||
        row.phoneId ||
        row.browsingId;
      if (seen.has(key)) continue;
      seen.add(key);
      survivors.push(row.browsingId);
      if (survivors.length === BROWSE_HISTORY_LIMIT) break;
    }

    // Anything we didn't keep is prune-eligible. Keep all rows we
    // walked past (which include the 10 unique), delete the rest.
    const keepIds = new Set(survivors);
    const purgeIds = rows
      .filter((r) => !keepIds.has(r.browsingId))
      .map((r) => r.browsingId);

    if (purgeIds.length > 0) {
      await prisma.browsingHistory.deleteMany({
        where: { browsingId: { in: purgeIds } },
      });
    }
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[profile] pruneBrowsingHistoryToLimit failed:",
        err?.message || err,
      );
    } else {
      console.warn("[profile] pruneBrowsingHistoryToLimit failed:", err);
    }
  }
}

// Record a "viewed a phone detail page" event. `BrowsingHistory` stores
// the human-readable label only — no FK to Phones by design (the schema
// comment preserves that intent). Skip if the label is missing.
//
// Dedup contract (per the user's brief): "if i clicked a phone that is
// in recent 10 then don't update score and track or shows in profile."
// We treat the last 10 unique phones as a rolling window. A new browse
// for any phone already in that window is dropped — no
// BrowsingHistory row, no Step B BehaviorScore bump. New unique phones
// pass through, then the table is pruned so the rolling window stays
// at exactly 10 unique entries.
export const safeRecordBrowseEvent = async (
  userId,
  { phoneLabel, brandName, phoneId },
) => {
  if (!userId) return;
  if (typeof phoneLabel !== "string" || phoneLabel.trim().length === 0) return;
  const cleanLabel = phoneLabel.trim().slice(0, 200);
  const cleanBrand =
    typeof brandName === "string" && brandName.trim().length > 0
      ? brandName.trim().slice(0, 60)
      : null;
  const cleanPhoneId = typeof phoneId === "string" ? phoneId : null;

  // 1. Dedup gate — checked before both the BrowsingHistory insert and
  //    the BehaviorScore bump so a re-click of an already-tracked phone
  //    is a true no-op.
  const isDup = await isDuplicateBrowse(userId, cleanLabel, cleanPhoneId);
  if (isDup) {
    return; // explicitly skip — neither row nor score update
  }

  try {
    await prisma.browsingHistory.create({
      data: {
        userId,
        phoneLabel: cleanLabel,
        brandName: cleanBrand,
        phoneId: cleanPhoneId,
        viewedAt: new Date(),
      },
    });
    // Trim the rolling window after a successful insert so the table
    // never grows beyond 10 unique phones. Best-effort: a pruning
    // failure doesn't unwind the insert.
    await pruneBrowsingHistoryToLimit(userId);
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[profile] recordBrowseEvent failed:", err?.message || err);
    } else {
      console.error("[profile] recordBrowseEvent failed:", err);
    }
  }

  // Step B — also write the view into the unified event log so the brand
  // / tier BehaviorScores accumulate. We only reach here when the
  // browse wasn't a duplicate, so the score bump is consistent with the
  // new BrowsingHistory row. `phoneId` is optional (callers that don't
  // have it pass nothing); the analyzer falls back to no phoneId
  // metadata lookup and skips the phone-derived tags.
  await safeRecordBehaviorEvent(userId, "view", {
    phoneId: cleanPhoneId,
    payload: {
      phoneLabel: cleanLabel,
      brandName: cleanBrand,
    },
  });
};

// Record a recommendation event. Per-result rows go to
// RecommendationHistory (only if the phone is in our catalog — the table
// has a FK). Per-call aggregates bump CustomerProfile.totalRecommendations.
export const safeRecordRecommendationEvent = async (
  userId,
  { persona, budget, results },
) => {
  if (!userId || !Array.isArray(results) || results.length === 0) return;
  try {
    const safePersona =
      typeof persona === "string" && persona.length > 0
        ? persona.slice(0, 60)
        : null;
    const filtersPayload = budget
      ? { budget, persona: safePersona, servedAt: new Date().toISOString() }
      : null;
    const filtersJsonValue = filtersPayload
      ? JSON.stringify(filtersPayload)
      : undefined;

    await prisma.$transaction(async (tx) => {
      // Insert a RecommendationHistory row for every catalog hit. Items
      // not in the catalog (`inDatabase === false`) are skipped so the
      // FK doesn't trip.
      const phoneIds = results
        .filter((r) => r && r.id && r.inDatabase !== false)
        .map((r) => r.id);
      if (phoneIds.length > 0) {
        // Per-row create is fine at typical topN=6 scale. Switch to a
        // `createMany` if we ever lift topN past ~50.
        for (const phoneId of phoneIds) {
          await tx.recommendationHistory.create({
            data: {
              userId,
              phoneId,
              personaSnapshot: safePersona,
              filtersJson: filtersJsonValue,
              searchDate: new Date(),
            },
          });
        }
      }

      await tx.customerProfile.upsert({
        where: { userId },
        create: {
          userId,
          totalRecommendations: results.length,
          recommendationPersona: safePersona,
        },
        update: {
          totalRecommendations: { increment: results.length },
          recommendationPersona: safePersona,
        },
      });
    });
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[profile] recordRecommendationEvent failed:", err?.message || err);
    } else {
      console.error("[profile] recordRecommendationEvent failed:", err);
    }
  }

  // Step B — one "recommend" event per call. The analyzer emits the
  // structural gaming/category deltas regardless of whether we know the
  // individual phoneIds — this is a high-level "user asked for a list"
  // signal. We stash the full result metadata in the payload for later
  // analysis.
  await safeRecordBehaviorEvent(userId, "recommend", {
    payload: {
      persona,
      budget,
      count: results.length,
    },
  });

  // Re-derive techTier / preferredRamGb / preferredStorageGb from the
  // user's last 25 recommendation rows. Fire-and-forget; the
  // aggregator self-throttles and is cheap when there is nothing to do.
  await safeAggregateAfterRecommendation(userId);
};

// Record a compare-ML event. Same FK constraint as RecommendationHistory:
// ComparisonHistory.phoneIdA/B must reference rows in Phones. If either
// model name doesn't resolve, we skip the row and just bump the counter.
export const safeRecordCompareEvent = async (
  userId,
  { modelNameA, modelNameB },
) => {
  if (!userId) return;
  if (
    typeof modelNameA !== "string" ||
    modelNameA.length === 0 ||
    typeof modelNameB !== "string" ||
    modelNameB.length === 0
  ) {
    return;
  }
  // Declared outside the try block so the Step B emit code below can
  // reference them even if the legacy write path throws. Both are
  // re-assigned inside the try; the Step B block is skipped on any
  // throw by the inner safeRecordBehaviorEvent try/catch.
  let phoneA = null;
  let phoneB = null;
  try {
    const phones = await prisma.phones.findMany({
      where: {
        isActive: true,
        OR: [
          { modelName: { equals: modelNameA, mode: "insensitive" } },
          { modelName: { equals: modelNameB, mode: "insensitive" } },
        ],
      },
      select: { phoneId: true, modelName: true },
    });

    phoneA = phones.find(
      (p) => p.modelName.toLowerCase() === modelNameA.toLowerCase(),
    );
    phoneB = phones.find(
      (p) => p.modelName.toLowerCase() === modelNameB.toLowerCase(),
    );

    await prisma.$transaction(async (tx) => {
      if (phoneA && phoneB) {
        await tx.comparisonHistory.create({
          data: {
            userId,
            phoneIdA: phoneA.phoneId,
            phoneIdB: phoneB.phoneId,
            comparedDate: new Date(),
          },
        });
      }
      await tx.customerProfile.upsert({
        where: { userId },
        create: { userId, totalComparisons: 1 },
        update: { totalComparisons: { increment: 1 } },
      });
    });
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[profile] recordCompareEvent failed:", err?.message || err);
    } else {
      console.error("[profile] recordCompareEvent failed:", err);
    }
  }

  // Step B — emit compare behaviour events so the behaviour analyzer
  // can derive per-phone feature / brand / tier deltas. Previously
  // this call passed no `phoneId`, which caused
  // `extractTagsForEvent` to short-circuit on null meta and write no
  // deltas — making repeated compare events invisible to the
  // personalization pipeline.
  //
  // Phase 3 (compare redesign):
  //   - We emit one event PER side (phoneA, phoneB) so each compared
  //     phone's tags accumulate.
  //   - Each payload now carries `pairKey` (sorted "phoneA::phoneB")
  //     and `opponentPhoneId`, so the analyzer can dedup at the pair
  //     level and ramp on UNIQUE PAIR COUNT rather than raw event
  //     count. Without pairKey the analyzer falls back to per-phone
  //     dedup + global ramp, which is what made 3 compares register
  //     as only 0.48 ramp strength.
  //   - The phone-level dedup gate inside behaviorAnalyzer is also
  //     intentionally bypassed for compare (compare was removed
  //     from `EVENT_DEDUPABLE_EVENTS`); pair dedup replaces it.
  //   - The diminishing-returns scalar still bounds repeat bumps
  //     (pair-based: first sight of a pair = 1.0, second = 0.45).
  //
  // safeRecordBehaviorEvent swallows every error internally, so this
  // block can never throw back into the catchAsync route — the
  // compare response always reaches the FE.
  if (phoneA && phoneA.phoneId) {
    await safeRecordBehaviorEvent(userId, "compare", {
      phoneId: phoneA.phoneId,
      payload: {
        side: "A",
        pairKey: phoneB?.phoneId
          ? [phoneA.phoneId, phoneB.phoneId].sort().join("::")
          : null,
        opponentPhoneId: phoneB?.phoneId || null,
        modelNameA: modelNameA.slice(0, 120),
        modelNameB: modelNameB.slice(0, 120),
      },
    });
  }
  if (phoneB && phoneB.phoneId) {
    await safeRecordBehaviorEvent(userId, "compare", {
      phoneId: phoneB.phoneId,
      payload: {
        side: "B",
        pairKey: phoneA?.phoneId
          ? [phoneA.phoneId, phoneB.phoneId].sort().join("::")
          : null,
        opponentPhoneId: phoneA?.phoneId || null,
        modelNameA: modelNameA.slice(0, 120),
        modelNameB: modelNameB.slice(0, 120),
      },
    });
  }
};

// ---------------------------------------------------------------------------
// Step D — behaviour-score map + recommendation-log write
// ---------------------------------------------------------------------------

// Read behavior scores as a `Map<tag, score>` for `searchHistoryScore`.
// Returns `null` when the user has no events (caller treats as neutral,
// meaning `searchHistoryScore` returns its 0.5 default).
//
// Reuses the same table the Step C `loadBehaviorScores` helper reads.
// We do the read inline rather than importing the helper to avoid
// pulling the whole profileFusion module into this service — the
// mapping here is two lines and the dependency graph stays flat.
export const loadBehaviorScoreMap = async (userId) => {
  if (!userId) return null;
  try {
    const rows = await prisma.behaviorScore.findMany({
      where: { userId },
      select: { tag: true, score: true },
    });
    if (!rows || rows.length === 0) return null;
    const out = new Map();
    for (const { tag, score } of rows) {
      out.set(tag, Number(score));
    }
    return out;
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[profile] loadBehaviorScoreMap failed:", err?.message || err);
    } else {
      console.error("[profile] loadBehaviorScoreMap failed:", err);
    }
    return null;
  }
};

export const getRecentEvents = async (userId, limit = 25) => {
  if (!userId) return [];
  try {
    const rows = await prisma.event.findMany({
      where: { userId, phoneId: { not: null } },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { eventType: true, phoneId: true },
    });
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[profile] getRecentEvents failed:", err?.message || err);
    } else {
      console.error("[profile] getRecentEvents failed:", err);
    }
    return [];
  }
};

export const loadPhoneMetaMap = async (phoneIds) => {
  const ids = Array.from(
    new Set((phoneIds || []).filter((id) => typeof id === "string" && id)),
  );
  const out = new Map();
  if (ids.length === 0) return out;
  try {
    const rows = await prisma.phones.findMany({
      where: { phoneId: { in: ids } },
      select: {
        phoneId: true,
        modelName: true,
        antutuScore: true,
        batteryMah: true,
        brand: { select: { name: true } },
        specs: {
          select: {
            chipset: true,
            mainCamera: true,
            refreshRate: true,
            displaySize: true,
          },
        },
      },
    });
    for (const row of rows) {
      out.set(row.phoneId, phoneMetaFromRow(row));
    }
    return out;
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[profile] loadPhoneMetaMap failed:", err?.message || err);
    } else {
      console.error("[profile] loadPhoneMetaMap failed:", err);
    }
    return out;
  }
};


// Fire-and-forget write into RecommendationLog. One row per served
// candidate — used for future segmentation clustering (the same
// cluster would consume these rows to derive the popularity signal
// that the 0.05 weight slot is reserved for).
//
// Accepts either a single row ({ rank, phoneId, finalScore }) or an
// array of rows (used by Issue 1's capped bulk write path that
// batches the top-N candidates into one createMany round-trip).
//
// Fire-and-forget policy: if the insert fails (transient DB error,
// FK trip on an inDatabase=false phone, etc.) the error is logged
// but never propagated. The recommendation response has already
// been queued for the user by the time this runs.
export const safeRecordRecommendationLog = async (userId, rowOrRows) => {
  if (!userId) return;
  const rows = Array.isArray(rowOrRows) ? rowOrRows : rowOrRows ? [rowOrRows] : [];
  const validRows = rows.filter(
    (r) => r && r.phoneId && Number.isFinite(Number(r.rank)),
  );
  if (validRows.length === 0) return;
  try {
    await prisma.recommendationLog.createMany({
      data: validRows.map((r) => ({
        userId,
        phoneId: r.phoneId,
        rank: Number(r.rank),
        finalScore: Number.isFinite(Number(r.finalScore)) ? Number(r.finalScore) : 0,
      })),
      skipDuplicates: true,
    });
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[profile] recordRecommendationLog failed:",
        err?.message || err,
      );
    } else {
      console.error("[profile] recordRecommendationLog failed:", err);
    }
  }
};

// ---------------------------------------------------------------------------
// RecommendationCall — one row per *recommendation call* (not per phone)
//
// Stores the per-call top-3 phones (resolved to `Brand · Model` already)
// so the admin "Last recommendation → Top results" panel can render
// human-readable names without fanning out the per-phone
// RecommendationHistory table. The JSON `topResults` shape is:
//   [{ phoneId, modelName, brand, rank, score }]
//
// Only the top 3 by match score are kept — the rest is intentionally
// discarded, this is a "what did the user last see" snapshot, not an
// analytics log. RecommendationHistory / RecommendationLog remain the
// per-phone truth.
//
// Fire-and-forget: a write failure must never break the recommendation
// response the user already received.
// ---------------------------------------------------------------------------

const TOP_RESULTS_LIMIT = 3;

export const safeRecordRecommendationCall = async (
  userId,
  { persona, budget, results },
) => {
  if (!userId || !Array.isArray(results) || results.length === 0) return;
  try {
    const topResults = results
      .slice()
      .sort((a, b) => (Number(b.matchScore) || 0) - (Number(a.matchScore) || 0))
      .slice(0, TOP_RESULTS_LIMIT)
      .map((r, i) => ({
        phoneId: r.id || null,
        modelName: r.modelName || null,
        brand: r.brand && r.brand.name ? r.brand.name : null,
        rank: i + 1,
        score: Number.isFinite(Number(r.matchScore)) ? Number(r.matchScore) : null,
      }));

    await prisma.recommendationCall.create({
      data: {
        userId,
        persona: typeof persona === "string" ? persona.slice(0, 60) : null,
        budget: budget && typeof budget === "object" ? budget : undefined,
        topResults,
        servedAt: new Date(),
      },
    });
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[profile] recordRecommendationCall failed:",
        err?.message || err,
      );
    } else {
      console.error("[profile] recordRecommendationCall failed:", err);
    }
  }
};

// ---------------------------------------------------------------------------
// Admin read — wrapper that exposes the same bundle shape but for any user
// ---------------------------------------------------------------------------

export const getCustomerProfileById = async (targetUserId) => {
  // Sanity check: refuse to read a phantom user so the admin endpoint
  // returns a clean 404 instead of an empty bundle.
  const exists = await prisma.users.findUnique({
    where: { userId: targetUserId },
    select: { userId: true },
  });
  if (!exists) {
    const { notFound } = await import("../utils/ApiError.mjs");
    throw notFound("Customer profile not found");
  }
  return getProfileBundle(targetUserId);
};
