// ---------------------------------------------------------------------------
// Import summary + report writer.
//
// The summary captures every decision the import makes so a CI job or an
// admin can spot regressions without re-reading the importer. Two outputs:
//   - a printed human-readable summary at the end of the run
//   - a stable JSON file at import-report.json for tooling
//
// Counts are kept on a single `ImportSummary` object that the orchestrator
// mutates as it goes. The shape is intentionally flat + numeric (with two
// objects: budget segment stats and skipped samples) so it's easy to diff
// across runs.
// ---------------------------------------------------------------------------

const MAX_SAMPLES = 5;

/**
 * @typedef {Object} ImportSummary
 * @property {string} csvPath
 * @property {Date}   startedAt
 * @property {Date}   finishedAt
 * @property {number} durationMs
 *
 * @property {number} totalRows             rows read from the CSV
 * @property {number} invalidCustomerRows   rows that failed normalizeRow
 * @property {number} rowWarnings           non-fatal warnings (e.g. negative amount nulled)
 *
 * @property {number} totalCustomers        unique customers in the file
 * @property {number} usersCreated          users successfully inserted
 * @property {number} usersSkippedExisting  users skipped because email already taken
 * @property {number} usersWithZeroBudget   users whose maxBudget defaulted to 0
 *
 * @property {number} wishlistItemsSeen
 * @property {number} wishlistItemsImported
 * @property {number} wishlistItemsSkippedUnknownBrand
 * @property {number} wishlistItemsSkippedUnknownPhone
 * @property {number} wishlistItemsSkippedDuplicate
 * @property {number} wishlistItemsSkippedInvalid
 *
 * @property {number} purchasesSeen
 * @property {number} purchasesImported
 * @property {number} purchasesSkippedInvalid
 *
 * @property {number} paymentRecordsCreated
 *
 * @property {number} browseEventsSeen
 * @property {number} browseEventsImported
 * @property {number} browseEventsSkippedInvalid
 * @property {number} searchEventsSeen
 * @property {number} searchEventsImported
 * @property {number} searchEventsSkippedInvalid
 *
 * @property {number} errors
 * @property {string[]} errorMessages       up to 100
 *
 * @property {string[]} preferredBrandsUnmatched
 *     sample of CSV preferred_brand values that didn't match any DB brand
 *
 * @property {{mapped:number, skipped:number, byValue:Object, unmappedValues:Object}} budgetSegmentStats
 * @property {Object} unmappedBudgetCategories
 */

/** @returns {ImportSummary} */
export function newSummary(csvPath) {
  return {
    csvPath,
    startedAt: new Date(),
    finishedAt: null,
    durationMs: 0,
    totalRows: 0,
    invalidCustomerRows: 0,
    rowWarnings: 0,
    totalCustomers: 0,
    usersCreated: 0,
    usersSkippedExisting: 0,
    usersWithZeroBudget: 0,
    wishlistItemsSeen: 0,
    wishlistItemsImported: 0,
    wishlistItemsSkippedUnknownBrand: 0,
    wishlistItemsSkippedUnknownPhone: 0,
    wishlistItemsSkippedDuplicate: 0,
    wishlistItemsSkippedInvalid: 0,
    purchasesSeen: 0,
    purchasesImported: 0,
    purchasesSkippedInvalid: 0,
    paymentRecordsCreated: 0,
    browseEventsSeen: 0,
    browseEventsImported: 0,
    browseEventsSkippedInvalid: 0,
    searchEventsSeen: 0,
    searchEventsImported: 0,
    searchEventsSkippedInvalid: 0,
    errors: 0,
    errorMessages: [],
    preferredBrandsUnmatched: [],
    budgetSegmentStats: { mapped: 0, skipped: 0, byValue: {} },
    unmappedBudgetCategories: {},
  };
}

/** Helper: append a sample to a bounded list, keeping it unique. */
export function pushSample(list, value, max = MAX_SAMPLES) {
  if (!value) return;
  if (list.includes(value)) return;
  if (list.length < max) list.push(value);
}

/**
 * @param {ImportSummary} s
 */
export function printSummary(s) {
  const sep = "─".repeat(72);
  console.log(`\n${sep}`);
  console.log("  IMPORT SUMMARY");
  console.log(sep);
  console.log(`  CSV                              ${s.csvPath}`);
  console.log(`  Duration                         ${(s.durationMs / 1000).toFixed(2)}s`);

  console.log("\n  — Input —");
  console.log(`  Total rows                       ${s.totalRows}`);
  console.log(`  Invalid customer rows            ${s.invalidCustomerRows}`);
  console.log(`  Non-fatal row warnings           ${s.rowWarnings}`);

  console.log("\n  — Customers —");
  console.log(`  Unique customers                 ${s.totalCustomers}`);
  console.log(`  Users created                    ${s.usersCreated}`);
  console.log(`  Users skipped (already exist)    ${s.usersSkippedExisting}`);
  console.log(`  Users with zero maxBudget        ${s.usersWithZeroBudget}`);

  console.log("\n  — Wishlist —");
  console.log(`  Items seen                       ${s.wishlistItemsSeen}`);
  console.log(`  Items imported                   ${s.wishlistItemsImported}`);
  console.log(
    `  Skipped — unknown brand          ${s.wishlistItemsSkippedUnknownBrand}`,
  );
  console.log(
    `  Skipped — unknown phone          ${s.wishlistItemsSkippedUnknownPhone}`,
  );
  console.log(
    `  Skipped — duplicate (user,phone) ${s.wishlistItemsSkippedDuplicate}`,
  );
  console.log(
    `  Skipped — invalid item           ${s.wishlistItemsSkippedInvalid}`,
  );

  console.log("\n  — Payments —");
  console.log(`  Purchases seen                   ${s.purchasesSeen}`);
  console.log(`  Purchases imported               ${s.purchasesImported}`);
  console.log(`  Purchases skipped (invalid)      ${s.purchasesSkippedInvalid}`);
  console.log(`  PaymentHistory rows created      ${s.paymentRecordsCreated}`);

  console.log("\n  — Browsing History —");
  console.log(`  Events seen                      ${s.browseEventsSeen}`);
  console.log(`  Events imported                  ${s.browseEventsImported}`);
  console.log(
    `  Events skipped (invalid)          ${s.browseEventsSkippedInvalid}`,
  );

  console.log("\n  — Search History —");
  console.log(`  Events seen                      ${s.searchEventsSeen}`);
  console.log(`  Events imported                  ${s.searchEventsImported}`);
  console.log(
    `  Events skipped (invalid)          ${s.searchEventsSkippedInvalid}`,
  );

  console.log("\n  — Budget segments —");
  if (s.budgetSegmentStats) {
    console.log(
      `  Mapped / Skipped                 ${s.budgetSegmentStats.mapped} / ${s.budgetSegmentStats.skipped}`,
    );
  }
  if (
    s.unmappedBudgetCategories &&
    Object.keys(s.unmappedBudgetCategories).length > 0
  ) {
    console.log(`  Unmapped budget categories:`);
    for (const [k, v] of Object.entries(s.unmappedBudgetCategories).sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`    - ${k} (${v})`);
    }
  }

  if (s.preferredBrandsUnmatched.length > 0) {
    console.log(`\n  Unmatched preferred brand samples:`);
    for (const b of s.preferredBrandsUnmatched) console.log(`    - ${b}`);
  }

  if (s.errors > 0) {
    console.log(`\n  Errors:                          ${s.errors}`);
    if (s.errorMessages.length > 0) {
      console.log(`  First 10 error messages:`);
      for (const m of s.errorMessages.slice(0, 10)) console.log(`    ! ${m}`);
    }
  }
  console.log(sep);
}

/**
 * Persist the summary as JSON. Best-effort; never throws.
 *
 * @param {ImportSummary} s
 * @param {string} outPath
 */
export async function writeReport(s, outPath) {
  const fs = await import("fs/promises");
  try {
    await fs.writeFile(outPath, JSON.stringify(s, null, 2), "utf8");
    console.log(`  Report written to ${outPath}`);
  } catch (err) {
    console.warn(`  Could not write report to ${outPath}: ${err.message}`);
  }
}
