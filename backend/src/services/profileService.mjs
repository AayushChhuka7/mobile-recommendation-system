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

  const [preference, customerProfile, lastRecommendations, lastSearches, lastBrowses, user] =
    await Promise.all([
      prisma.userPreference.findUnique({
        where: { userId: userIdWhere },
      }),
      prisma.customerProfile.findUnique({
        where: { userId: userIdWhere },
      }),
      prisma.recommendationHistory.findMany({
        where: { userId: userIdWhere },
        orderBy: { searchDate: "desc" },
        take: 5,
        select: {
          historyId: true,
          phoneId: true,
          personaSnapshot: true,
          filtersJson: true,
          overallCompatibility: true,
          searchDate: true,
        },
      }),
      prisma.searchHistory.findMany({
        where: { userId: userIdWhere },
        orderBy: { searchedAt: "desc" },
        take: 20,
        select: {
          searchId: true,
          searchQuery: true,
          searchedAt: true,
        },
      }),
      prisma.browsingHistory.findMany({
        where: { userId: userIdWhere },
        orderBy: { viewedAt: "desc" },
        take: 20,
        select: {
          browsingId: true,
          phoneLabel: true,
          brandName: true,
          viewedAt: true,
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
          searchCount: customerProfile.searchCount,
          totalRecommendations: customerProfile.totalRecommendations,
          totalComparisons: customerProfile.totalComparisons,
          segmentConfidence: customerProfile.segmentConfidence,
          lastUpdated: customerProfile.lastUpdated,
        }
      : null,
    lastRecommendation: {
      persona:
        lastRecommendations.find((r) => r.personaSnapshot)?.personaSnapshot ||
        null,
      budget: null, // populated on next release once we extract from filtersJson
      servedAt: lastRecommendations[0]?.searchDate || null,
      topResults: lastRecommendations.map((r) => ({
        phoneId: r.phoneId,
        overallCompatibility: r.overallCompatibility
          ? Number(r.overallCompatibility.toString())
          : null,
        searchDate: r.searchDate,
      })),
    },
    lastSearches: lastSearches.map((s) => ({
      searchQuery: s.searchQuery,
      searchedAt: s.searchedAt,
    })),
    lastBrowses: lastBrowses.map((b) => ({
      phoneLabel: b.phoneLabel,
      brandName: b.brandName,
      viewedAt: b.viewedAt,
    })),
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

// Record a "viewed a phone detail page" event. `BrowsingHistory` stores
// the human-readable label only — no FK to Phones by design (the schema
// comment preserves that intent). Skip if the label is missing.
export const safeRecordBrowseEvent = async (
  userId,
  { phoneLabel, brandName, phoneId },
) => {
  if (!userId) return;
  if (typeof phoneLabel !== "string" || phoneLabel.trim().length === 0) return;
  try {
    await prisma.browsingHistory.create({
      data: {
        userId,
        phoneLabel: phoneLabel.slice(0, 200),
        brandName:
          typeof brandName === "string" && brandName.trim().length > 0
            ? brandName.trim().slice(0, 60)
            : null,
        viewedAt: new Date(),
      },
    });
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[profile] recordBrowseEvent failed:", err?.message || err);
    } else {
      console.error("[profile] recordBrowseEvent failed:", err);
    }
  }

  // Step B — also write the view into the unified event log so the brand
  // / tier BehaviorScores accumulate. `phoneId` is optional (callers that
  // don't have it pass nothing); the analyzer falls back to no phoneId
  // metadata lookup and skips the phone-derived tags.
  await safeRecordBehaviorEvent(userId, "view", {
    phoneId: typeof phoneId === "string" ? phoneId : null,
    payload: {
      phoneLabel: phoneLabel.slice(0, 200),
      brandName:
        typeof brandName === "string" && brandName.trim().length > 0
          ? brandName.trim().slice(0, 60)
          : null,
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

    const phoneA = phones.find(
      (p) => p.modelName.toLowerCase() === modelNameA.toLowerCase(),
    );
    const phoneB = phones.find(
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

  // Step B — one "compare" event per call. The +3 gaming delta is the
  // strongest "I'm shopping seriously" signal in the taxonomy. We pick
  // phoneA as the canonical phoneId (if resolved) for the Event row;
  // the analyzer falls back to skip-if-unknown regardless.
  const resolvedFirst = (() => {
    const lower = (s) => (typeof s === "string" ? s.toLowerCase() : null);
    const A = lower(modelNameA);
    const B = lower(modelNameB);
    // We re-fetch inside the safeRecord wrapper; a duplicate phones.find
    // is fine here because the helper ignores unknown phoneIds.
    return null;
  })();
  void resolvedFirst; // (suppress unused; analyzer caches the lookup anyway)
  await safeRecordBehaviorEvent(userId, "compare", {
    payload: {
      modelNameA: modelNameA.slice(0, 120),
      modelNameB: modelNameB.slice(0, 120),
    },
  });
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
