// ---------------------------------------------------------------------------
// CSV parsing + per-row normalization for the customer dataset.
//
// The CSV has many fields that are either JSON-encoded, boolean-ish, or
// optional. This module is the single source of truth for turning one raw
// CSV row into a normalized `NormalizedRow` object the rest of the pipeline
// can rely on.
//
// All coercion helpers fail soft — a missing or malformed value becomes
// `null` rather than throwing. The orchestrator decides whether to skip the
// row and which fields are mandatory for the row to be importable.
//
// `normalizeRow` returns either:
//   - { row: NormalizedRow, warnings: string[] }  on success
//   - { error: string }                            on hard failure
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} NormalizedRow
 * @property {string}            customerId        non-empty, length ≤ 80
 * @property {string}            customerName      non-empty, length ≤ 120
 * @property {number|null}       age               0..120 or null
 * @property {string|null}       gender            length ≤ 20
 * @property {string|null}       city              length ≤ 80
 * @property {string|null}       country           length ≤ 80
 * @property {string|null}       mobileBrand       length ≤ 60
 * @property {string|null}       mobileModel       length ≤ 120
 * @property {Date|null}         purchaseDate      finite, not NaN
 * @property {number|null}       purchaseAmountNpr non-negative finite
 * @property {string|null}       paymentMethod     length ≤ 60
 * @property {number|null}       purchaseFrequencyPerYear non-negative
 * @property {number|null}       averageSpendNpr   non-negative
 * @property {Array}             browsingHistory   raw parsed JSON
 * @property {Array}             wishlist          raw parsed JSON
 * @property {number|null}       rating            1..5 or null
 * @property {string|null}       review            length ≤ 1000
 * @property {string|null}       preferredBrand    length ≤ 60
 * @property {string|null}       preferredCategory length ≤ 40
 * @property {Array}             accessoriesPurchased
 * @property {string|null}       warrantyOpted     length ≤ 40
 * @property {Array}             exchangeHistory
 * @property {string|null}       interactionChannel length ≤ 60
 * @property {Date|null}         lastActiveAt
 * @property {number}            sourceLine
 * @property {string[]}          warnings          non-fatal problems on this row
 */

const MAX_LEN = {
  customerId: 80,
  customerName: 120,
  mobileBrand: 60,
  mobileModel: 120,
  preferredBrand: 60,
  preferredCategory: 40,
  gender: 20,
  city: 80,
  country: 80,
  paymentMethod: 60,
  interactionChannel: 60,
  warrantyOpted: 40,
  review: 1000,
};

const UUID_LIKE = /^[A-Z0-9]+-[A-Z0-9]+$/i; // matches "CUST-XXXXXXXX" style

// ---- low-level coercion helpers -------------------------------------------

function toStringOrNull(v, maxLen) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  if (maxLen && s.length > maxLen) return s.slice(0, maxLen);
  return s;
}

/** Strictly positive or zero finite integer. Rejects NaN, Infinity, -0, junk. */
function toIntOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  // Strip currency symbols / thousands separators.
  const cleaned = s.replace(/[^\d.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

/** Strictly non-negative finite float. Rejects NaN, Infinity, negative. */
function toFloatOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const cleaned = s.replace(/[^\d.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * Date parse. The CSV is wall-clock (no timezone), so we treat naive
 * datetimes ("YYYY-MM-DD HH:MM:SS", "YYYY-MM-DD") as UTC. Without this,
 * a machine in a non-UTC timezone would shift the timestamp by the
 * local offset, and `2021-06-26 12:00:00` would land at 06:15 UTC on a
 * +05:45 host. Pinning to UTC makes the import deterministic and
 * timezone-independent.
 *
 * Returns null on failure.
 */
function toDateOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  // Accept "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DD"
  let isoish = s.includes(" ") ? s.replace(" ", "T") : s;
  if (!/[Zz]|[+\-]\d{2}:?\d{2}$/.test(isoish)) isoish += "Z";
  const d = new Date(isoish);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function toWarrantyOpted(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  return s.length > MAX_LEN.warrantyOpted
    ? s.slice(0, MAX_LEN.warrantyOpted)
    : s;
}

/**
 * Parse a JSON-typed CSV cell into an array. Returns `null` when the cell
 * is present but unparseable (caller can decide to count it as a warning),
 * and `[]` when the cell is empty / missing / explicitly `[]`.
 */
function toJsonArrayOrNull(v) {
  if (v === undefined || v === null) return [];
  const s = String(v).trim();
  if (s === "" || s === "[]") return [];
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed;
    return null; // present but not an array
  } catch {
    return null; // malformed
  }
}

// ---- single-row normalizer -------------------------------------------------

/**
 * Normalize one raw CSV record (object keyed by header name).
 *
 * Returns:
 *   { row, warnings } on success (warnings may be empty)
 *   { error }         on hard failure (missing required field, junk id, …)
 *
 * @param {Record<string,string>} row
 * @param {number} lineNumber  1-indexed line in the source file (for logging)
 * @returns {{row: NormalizedRow, warnings: string[]} | {error: string}}
 */
export function normalizeRow(row, lineNumber) {
  const warnings = [];
  const fail = (msg) => ({ error: `${msg} (line ${lineNumber})` });

  // ---- required: customer_id ----
  const rawCustomerId = row.customer_id;
  if (rawCustomerId == null || String(rawCustomerId).trim() === "") {
    return fail("missing required field 'customer_id'");
  }
  const customerId = String(rawCustomerId).trim();
  if (customerId.length > MAX_LEN.customerId) {
    return fail(`customer_id exceeds ${MAX_LEN.customerId} chars`);
  }
  if (!UUID_LIKE.test(customerId)) {
    warnings.push(
      `customer_id '${customerId}' does not look like a stable id; proceeding anyway`,
    );
  }

  // ---- required: customer_name ----
  const rawName = row.customer_name;
  if (rawName == null || String(rawName).trim() === "") {
    return fail("missing required field 'customer_name'");
  }
  const customerName = String(rawName).trim();
  if (customerName.length > MAX_LEN.customerName) {
    return fail(`customer_name exceeds ${MAX_LEN.customerName} chars`);
  }

  // ---- numeric fields with strictness ----
  const age = toIntOrNull(row.age);
  if (row.age != null && String(row.age).trim() !== "" && age == null) {
    warnings.push(`unparseable age '${row.age}'`);
  } else if (age != null && (age < 0 || age > 120)) {
    warnings.push(`age ${age} out of range; nulled`);
  }
  const ageSafe = age != null && age >= 0 && age <= 120 ? age : null;

  const purchaseAmountNpr = toFloatOrNull(row.purchase_amount_npr);
  if (
    row.purchase_amount_npr != null &&
    String(row.purchase_amount_npr).trim() !== "" &&
    purchaseAmountNpr == null
  ) {
    warnings.push(`unparseable purchase_amount_npr '${row.purchase_amount_npr}'`);
  } else if (purchaseAmountNpr != null && purchaseAmountNpr < 0) {
    warnings.push(
      `negative purchase_amount_npr ${purchaseAmountNpr}; nulled`,
    );
  }
  const amountSafe =
    purchaseAmountNpr != null && purchaseAmountNpr >= 0
      ? purchaseAmountNpr
      : null;

  const purchaseFrequencyPerYear = toFloatOrNull(
    row.purchase_frequency_per_year,
  );
  if (
    row.purchase_frequency_per_year != null &&
    String(row.purchase_frequency_per_year).trim() !== "" &&
    purchaseFrequencyPerYear == null
  ) {
    warnings.push(
      `unparseable purchase_frequency_per_year '${row.purchase_frequency_per_year}'`,
    );
  } else if (purchaseFrequencyPerYear != null && purchaseFrequencyPerYear < 0) {
    warnings.push(
      `negative purchase_frequency_per_year ${purchaseFrequencyPerYear}; nulled`,
    );
  }
  const freqSafe =
    purchaseFrequencyPerYear != null && purchaseFrequencyPerYear >= 0
      ? purchaseFrequencyPerYear
      : null;

  const averageSpendNpr = toFloatOrNull(row.average_spend_npr);
  if (
    row.average_spend_npr != null &&
    String(row.average_spend_npr).trim() !== "" &&
    averageSpendNpr == null
  ) {
    warnings.push(`unparseable average_spend_npr '${row.average_spend_npr}'`);
  } else if (averageSpendNpr != null && averageSpendNpr < 0) {
    warnings.push(`negative average_spend_npr ${averageSpendNpr}; nulled`);
  }
  const avgSafe =
    averageSpendNpr != null && averageSpendNpr >= 0 ? averageSpendNpr : null;

  const rating = toIntOrNull(row.rating);
  const ratingSafe =
    rating != null && rating >= 1 && rating <= 5 ? rating : null;
  if (
    row.rating != null &&
    String(row.rating).trim() !== "" &&
    ratingSafe == null
  ) {
    warnings.push(`rating '${row.rating}' out of 1..5; nulled`);
  }

  // ---- date fields ----
  const purchaseDate = toDateOrNull(row.purchase_date);
  if (
    row.purchase_date != null &&
    String(row.purchase_date).trim() !== "" &&
    purchaseDate == null
  ) {
    warnings.push(`unparseable purchase_date '${row.purchase_date}'`);
  }

  const lastActiveAt = toDateOrNull(row.last_active_at);
  if (
    row.last_active_at != null &&
    String(row.last_active_at).trim() !== "" &&
    lastActiveAt == null
  ) {
    warnings.push(`unparseable last_active_at '${row.last_active_at}'`);
  }

  // ---- JSON fields (each tracked separately so a malformed cell can warn
  //      without poisoning the row) ----
  const browsingHistory = toJsonArrayOrNull(row.browsing_history);
  if (browsingHistory === null) {
    warnings.push("malformed browsing_history JSON; treated as empty");
  }

  const wishlist = toJsonArrayOrNull(row.wishlist);
  if (wishlist === null) {
    warnings.push("malformed wishlist JSON; treated as empty");
  }

  const accessoriesPurchased = toJsonArrayOrNull(row.accessories_purchased);
  if (accessoriesPurchased === null) {
    warnings.push("malformed accessories_purchased JSON; treated as empty");
  }

  const exchangeHistory = toJsonArrayOrNull(row.exchange_history);
  if (exchangeHistory === null) {
    warnings.push("malformed exchange_history JSON; treated as empty");
  }

  return {
    row: {
      customerId,
      customerName,
      age: ageSafe,
      gender: toStringOrNull(row.gender, MAX_LEN.gender),
      city: toStringOrNull(row.city, MAX_LEN.city),
      country: toStringOrNull(row.country, MAX_LEN.country),
      mobileBrand: toStringOrNull(
        row.mobile_brand_purchased,
        MAX_LEN.mobileBrand,
      ),
      mobileModel: toStringOrNull(
        row.mobile_model_purchased,
        MAX_LEN.mobileModel,
      ),
      purchaseDate,
      purchaseAmountNpr: amountSafe,
      paymentMethod: toStringOrNull(
        row.payment_method,
        MAX_LEN.paymentMethod,
      ),
      purchaseFrequencyPerYear: freqSafe,
      averageSpendNpr: avgSafe,
      browsingHistory: browsingHistory ?? [],
      wishlist: wishlist ?? [],
      rating: ratingSafe,
      review: toStringOrNull(row.review, MAX_LEN.review),
      preferredBrand: toStringOrNull(
        row.preferred_brand,
        MAX_LEN.preferredBrand,
      ),
      preferredCategory: toStringOrNull(
        row.preferred_category,
        MAX_LEN.preferredCategory,
      ),
      accessoriesPurchased: accessoriesPurchased ?? [],
      warrantyOpted: toWarrantyOpted(row.warranty_opted),
      exchangeHistory: exchangeHistory ?? [],
      interactionChannel: toStringOrNull(
        row.interaction_channel,
        MAX_LEN.interactionChannel,
      ),
      lastActiveAt,
      sourceLine: lineNumber,
      warnings,
    },
    warnings,
  };
}
