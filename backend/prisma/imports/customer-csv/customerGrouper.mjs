// ---------------------------------------------------------------------------
// Group normalized CSV rows by customer_id, applying the "most recent
// purchase wins" rule for per-customer fields while accumulating:
//
//   - unique preferred brand names (preserved across the full history)
//   - one entry per purchase (for the PaymentHistory table)
//   - wishlist items (validated against the catalog later)
//   - browsing / search events (validated against catalog later, or
//     preserved verbatim for BrowsingHistory)
//
// Per-customer "stable" fields (name, age, gender, city, country,
// preferred_category, average_spend_npr, purchase_frequency_per_year,
// interaction_channel, last_active_at) are taken from the row with the
// most recent timestamp, preferring `lastActiveAt` and falling back to
// `purchaseDate` when the activity timestamp is missing. `preferredBrands`
// is the ONE exception: it accumulates, never overwrites — the user wants
// the full set preserved.
// ---------------------------------------------------------------------------

/**
 * @typedef {import("./csvParser.mjs").NormalizedRow} NormalizedRow
 *
 * @typedef {Object} Purchase
 * @property {Date|null}   purchaseDate
 * @property {number|null} purchaseAmountNpr
 * @property {string|null} paymentMethod
 * @property {string|null} warrantyOpted
 * @property {Array}       exchangeHistory
 * @property {string|null} phoneLabel
 * @property {number}      sourceLine
 *
 * @typedef {Object} HistoryEvent
 * @property {string}    item        the raw CSV value
 * @property {Date|null} eventAt     the CSV's viewed_at / searched_at
 * @property {number}    sourceLine
 *
 * @typedef {Object} CustomerGroup
 * @property {string}          customerId
 * @property {string}          customerName
 * @property {number|null}     age
 * @property {string|null}     gender
 * @property {string|null}     city
 * @property {string|null}     country
 * @property {Set<string>}     preferredBrands
 *     Unique preferred brand names (case-insensitive dedup, first-seen
 *     casing preserved). NEVER overwritten by the latest-row rule —
 *     the spec explicitly says "do not overwrite with only the latest".
 * @property {string|null}     latestPreferredCategory
 * @property {number|null}     purchaseFrequencyPerYear
 * @property {number|null}     averageSpendNpr
 * @property {string|null}     interactionChannel
 * @property {Date|null}       lastActiveAt
 * @property {Purchase[]}      purchases
 * @property {WishlistItem[]}  wishlistItems
 * @property {HistoryEvent[]}  browseEvents
 *     One per `browsing_history` entry. Deduped only within a single row
 *     (per the spec — repeated views are meaningful behavior).
 * @property {HistoryEvent[]}  searchEvents
 *     Same data as browseEvents but routed to SearchHistory; the user
 *     asked us to use `browsing_history` for both tables.
 * @property {number}          firstSourceLine
 * @property {string[]}        warnings
 *
 * @typedef {Object} WishlistItem
 * @property {string} brand
 * @property {string} model
 * @property {Date|null} addedAt
 * @property {boolean} purchased
 * @property {number}  sourceLine
 */

/**
 * Fields that are taken from the row with the most recent timestamp. These
 * are OVERWRITTEN by the latest-wins rule. `preferredBrands` is NOT in this
 * list — it accumulates (see JSDoc above).
 *
 * Entries are `[groupField, rowField]` pairs because some fields are
 * renamed between the row shape (`preferredCategory`) and the group shape
 * (`latestPreferredCategory`).
 */
const LATEST_WINS_FIELDS = [
  ["customerName", "customerName"],
  ["age", "age"],
  ["gender", "gender"],
  ["city", "city"],
  ["country", "country"],
  ["latestPreferredCategory", "preferredCategory"],
  ["purchaseFrequencyPerYear", "purchaseFrequencyPerYear"],
  ["averageSpendNpr", "averageSpendNpr"],
  ["interactionChannel", "interactionChannel"],
  ["lastActiveAt", "lastActiveAt"],
];

/**
 * Group normalized rows by customer_id.
 *
 * @param {NormalizedRow[]} rows
 * @returns {Map<string, CustomerGroup>}
 */
export function groupByCustomer(rows) {
  /** @type {Map<string, CustomerGroup>} */
  const groups = new Map();

  for (const r of rows) {
    if (!r || r.error) continue; // skip invalid rows (defensive)

    let group = groups.get(r.customerId);
    if (!group) {
      group = {
        customerId: r.customerId,
        customerName: r.customerName,
        age: r.age,
        gender: r.gender,
        city: r.city,
        country: r.country,
        preferredBrands: new Set(),
        // Parallel lowercase set for O(1) case-insensitive membership.
        // (Kept on the function scope, not exposed.)
        latestPreferredCategory: r.preferredCategory,
        purchaseFrequencyPerYear: r.purchaseFrequencyPerYear,
        averageSpendNpr: r.averageSpendNpr,
        interactionChannel: r.interactionChannel,
        lastActiveAt: r.lastActiveAt,
        purchases: [],
        wishlistItems: [],
        browseEvents: [],
        searchEvents: [],
        firstSourceLine: r.sourceLine,
        warnings: [],
      };
      groups.set(r.customerId, group);
      // Lazy init of the lowercase parallel set per group.
      // (Maps on group objects are fine — group is private to this fn.)
      group._preferredBrandsLower = new Set();
    }

    // ---- Accumulate preferred brands (never overwrites) ----
    if (r.preferredBrand) {
      const key = r.preferredBrand.toLowerCase();
      if (!group._preferredBrandsLower.has(key)) {
        group._preferredBrandsLower.add(key);
        group.preferredBrands.add(r.preferredBrand);
      }
    }

    // ---- Record the purchase event ----
    // A row counts as a purchase if it has any of: a date, an amount, or a
    // model. The strict numeric guards already nulled invalid amounts, so
    // by the time we get here `purchaseAmountNpr` is either null or ≥ 0.
    if (r.purchaseDate || r.purchaseAmountNpr != null || r.mobileModel) {
      group.purchases.push({
        purchaseDate: r.purchaseDate,
        purchaseAmountNpr: r.purchaseAmountNpr,
        paymentMethod: r.paymentMethod,
        warrantyOpted: r.warrantyOpted,
        exchangeHistory: r.exchangeHistory,
        phoneLabel:
          r.mobileBrand && r.mobileModel
            ? `${r.mobileBrand} ${r.mobileModel}`
            : r.mobileModel || r.mobileBrand || null,
        sourceLine: r.sourceLine,
      });
    }

    // ---- Accumulate wishlist items ----
    for (const item of r.wishlist) {
      if (!item || typeof item !== "object") continue;
      const label = String(item.item ?? "").trim();
      if (!label) continue;
      const { brand, model } = splitBrandModel(label);
      if (!brand || !model) continue;
      group.wishlistItems.push({
        brand,
        model,
        addedAt: item.added_at ? new Date(item.added_at) : null,
        purchased: Boolean(item.purchased),
        sourceLine: r.sourceLine,
      });
    }

    // ---- Accumulate browsing / search history events ----
    // Spec: dedupe only within the same CSV row, never across rows.
    // Each entry becomes both a BrowsingHistory row and a SearchHistory
    // row (per the user's chosen mapping).
    {
      const seenInRow = new Set();
      for (const e of r.browsingHistory) {
        if (!e || typeof e !== "object") continue;
        const item = String(e.item ?? "").trim();
        if (!item) continue;
        const key = item.toLowerCase();
        if (seenInRow.has(key)) continue;
        seenInRow.add(key);
        // Use the parser's TZ-safe date helper so wall-clock values like
        // "2021-06-26 12:00:00" round-trip as 12:00 UTC instead of
        // shifting to local time.
        const eventAt = parseNaiveAsUtc(e.viewed_at);
        const evt = { item, eventAt, sourceLine: r.sourceLine };
        group.browseEvents.push(evt);
        group.searchEvents.push(evt);
      }
    }

    // ---- Bubble up any row-level warnings ----
    if (r.warnings && r.warnings.length > 0) {
      group.warnings.push(...r.warnings.map((w) => `line ${r.sourceLine}: ${w}`));
    }

    // ---- "Most recent row wins" for per-customer stable fields ----
    // Recency = max(lastActiveAt, purchaseDate). We pick whichever
    // timestamp is more recent so a row with no `lastActiveAt` can still
    // be considered "later" if its purchase date is more recent.
    const currentRecency = recency(group.lastActiveAt, purchasesMaxDate(group));
    const rowRecency = recency(r.lastActiveAt, r.purchaseDate);
    if (
      rowRecency != null &&
      (currentRecency == null || rowRecency >= currentRecency)
    ) {
      for (const [groupField, rowField] of LATEST_WINS_FIELDS) {
        const v = r[rowField];
        if (v != null) group[groupField] = v;
      }
    }
  }

  // Strip the parallel lowercase set before returning — it's an internal
  // detail, not part of the public group shape.
  for (const g of groups.values()) {
    delete g._preferredBrandsLower;
  }

  return groups;
}

// ---- internal helpers ------------------------------------------------------

/**
 * Parse a CSV wall-clock datetime ("YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DD")
 * as UTC. Mirrors the parser's behavior so that the grouper doesn't
 * accidentally re-introduce a local-timezone shift.
 *
 * @param {string|null|undefined} v
 * @returns {Date|null}
 */
function parseNaiveAsUtc(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  let isoish = s.includes(" ") ? s.replace(" ", "T") : s;
  if (!/[Zz]|[+\-]\d{2}:?\d{2}$/.test(isoish)) isoish += "Z";
  const d = new Date(isoish);
  return Number.isNaN(d.getTime()) ? null : d;
}

function recency(lastActiveAt, purchaseDate) {
  const a = ts(lastActiveAt);
  const b = ts(purchaseDate);
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

function purchasesMaxDate(group) {
  if (!group.purchases || group.purchases.length === 0) return null;
  let max = null;
  for (const p of group.purchases) {
    const t = ts(p.purchaseDate);
    if (t == null) continue;
    if (max == null || t > max) max = t;
  }
  return max == null ? null : new Date(max);
}

function ts(d) {
  if (!d) return null;
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Split a wishlist item label like "Apple iPhone 11" into {brand, model}.
 * Brand names observed in the dataset drive the prefix list — keep in sync
 * with the actual catalog in production. This is intentionally a small
 * static list; the catalog cache is the source of truth at lookup time.
 *
 * @param {string} label
 * @returns {{brand: string|null, model: string|null}}
 */
export function splitBrandModel(label) {
  const BRANDS = [
    "samsung",
    "apple",
    "xiaomi",
    "huawei",
    "oppo",
    "vivo",
    "realme",
    "oneplus",
    "honor",
    "motorola",
    "nokia",
    "infinix",
    "tecno",
    "google",
    "sony",
    "asus",
    "lenovo",
  ];
  const lower = label.toLowerCase();
  const sorted = [...BRANDS].sort((a, b) => b.length - a.length);
  for (const b of sorted) {
    if (lower.startsWith(b + " ")) {
      return {
        brand: label.slice(0, b.length),
        model: label.slice(b.length + 1).trim(),
      };
    }
    if (lower === b) {
      return { brand: label, model: "" };
    }
  }
  const idx = label.indexOf(" ");
  if (idx <= 0) return { brand: null, model: null };
  return { brand: label.slice(0, idx), model: label.slice(idx + 1).trim() };
}
