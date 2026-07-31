// ---------------------------------------------------------------------------
// Customer CSV import — main orchestrator.
//
// Pipeline (per the spec):
//   1. Read CSV
//   2. Normalize + validate rows
//   3. Group by customer_id
//   4. For each customer (one transaction):
//        a. INSERT user (idempotent via email unique constraint)
//        b. INSERT user_profiles, user_preferences, customer_profiles
//        c. INSERT wishlist (createMany + skipDuplicates)
//        d. INSERT payment_history (createMany)
//   5. Print + persist summary
//
// Guarantees:
//   - NEVER creates Brands, Phones, or PhoneSpecs.
//   - Idempotent on customer email `${customerId}@import.local`.
//     Skips users that already exist (their wishlist/payment history is
//     left untouched).
//   - One transaction per customer. A failure in any single customer's
//     row rolls back that customer only — the rest of the import continues.
//   - All skip conditions are counted and reported with samples.
//   - createMany is used for wishlist + payment_history (single round-trip
//     per table, atomic inside the customer transaction).
//
// Usage:
//   node prisma/imports/customer-csv/importCustomers.mjs \
//     [path/to/customer_dataset.csv]
//   defaults to ../../dataset/customer_dataset.csv
//
// Requires:
//   - DATABASE_URL set
//   - prisma generate has been run
//   - Migrations applied (initial + add_customer_csv_import)
// ---------------------------------------------------------------------------

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse } from "csv-parse/sync";

import { prisma } from "../../../src/config/prisma.mjs";
import { normalizeRow } from "./csvParser.mjs";
import {
  buildCatalogCache,
  findBrand,
  findBrandCanonical,
  findPhone,
} from "./catalogCache.mjs";
import { groupByCustomer } from "./customerGrouper.mjs";
import { generateHashedPassword } from "./passwordHash.mjs";
import {
  mapBudgetSegment,
  newSegmentStats,
} from "./budgetSegmentMapper.mjs";
import {
  newSummary,
  printSummary,
  writeReport,
  pushSample,
} from "./reporter.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CSV = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "dataset",
  "customer_dataset.csv",
);
const CSV_PATH = process.argv[2] || DEFAULT_CSV;

const REPORT_PATH = path.resolve(__dirname, "import-report.json");
const PROGRESS_INTERVAL = 1000;
const LOG = (msg) => console.log(msg);

// ---------------------------------------------------------------------------
// Step 1: read CSV
// ---------------------------------------------------------------------------
function readCsv(csvPath) {
  const raw = fs.readFileSync(csvPath, "utf8");
  return parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    relax_column_count: true,
  });
}

// ---------------------------------------------------------------------------
// Step 2: normalize + group
// ---------------------------------------------------------------------------
function normalizeAndGroup(rawRows) {
  const summary = newSummary(CSV_PATH);
  const normalized = [];

  for (let i = 0; i < rawRows.length; i++) {
    const lineNumber = i + 2; // +2: 1 for header, 1 for 1-indexed
    const row = rawRows[i];
    const out = normalizeRow(row, lineNumber);
    if ("error" in out) {
      summary.invalidCustomerRows += 1;
      summary.errors += 1;
      if (summary.errorMessages.length < 100) {
        summary.errorMessages.push(`line ${lineNumber}: ${out.error}`);
      }
      continue;
    }
    if (out.warnings.length > 0) {
      summary.rowWarnings += out.warnings.length;
      // Bubble the first few warnings to the errorMessages so they're
      // visible without opening the report file.
      for (const w of out.warnings.slice(0, 3)) {
        if (summary.errorMessages.length < 100) {
          summary.errorMessages.push(`line ${lineNumber}: ${w}`);
        }
      }
    }
    normalized.push(out.row);
    if (i > 0 && i % PROGRESS_INTERVAL === 0) {
      LOG(`  ...parsed ${i} rows`);
    }
  }

  summary.totalRows = rawRows.length;
  const groups = groupByCustomer(normalized);
  summary.totalCustomers = groups.size;
  return { groups, summary };
}

// ---------------------------------------------------------------------------
// Per-customer plan builders
//
// Each returns the Prisma data shape that will be passed to the
// corresponding create. Splitting these out keeps the transaction body
// small and makes each decision unit-testable.
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical preferred brands list. We try to map every CSV
 * value to the brand's DB-canonical name (case/whitespace-insensitive
 * match). Unknown brands are kept verbatim (without modification) so we
 * don't lose the signal, but they're flagged in the report. Rationale:
 *   - If the brand is in the DB, the canonical name is what the
 *     recommender and admin UI will display, so we store that.
 *   - If it's not, dropping it would silently lose a preference;
 *     keeping it preserves the information for a future brand-add.
 *
 * @param {import("./customerGrouper.mjs").CustomerGroup} group
 * @param {import("./catalogCache.mjs").CatalogCache} catalog
 * @param {ImportSummary} summary
 * @returns {{ canonicalNames: string[], preferredBrandId: string|null }}
 */
function resolvePreferredBrands(group, catalog, summary) {
  const canonicalNames = [];
  let preferredBrandId = null;
  for (const name of group.preferredBrands) {
    const canonical = findBrandCanonical(catalog, name);
    if (canonical) {
      if (!canonicalNames.includes(canonical)) canonicalNames.push(canonical);
      if (!preferredBrandId) {
        preferredBrandId = findBrand(catalog, name);
      }
    } else {
      // Keep the raw value but flag it in the report (one sample per value).
      pushSample(summary.preferredBrandsUnmatched, name);
      if (!canonicalNames.includes(name)) canonicalNames.push(name);
    }
  }
  return { canonicalNames, preferredBrandId };
}

/**
 * Resolve wishlist items against the catalog. Returns a de-duplicated list
 * of `{ phoneId, addedDate }` ready for `createMany`. Counts every skip
 * reason in the summary.
 *
 * @param {import("./customerGrouper.mjs").CustomerGroup} group
 * @param {import("./catalogCache.mjs").CatalogCache} catalog
 * @param {ImportSummary} summary
 * @returns {Array<{phoneId: string, addedDate: Date}>}
 */
function resolveWishlist(group, catalog, summary) {
  const seen = new Set();
  const result = [];
  for (const item of group.wishlistItems) {
    summary.wishlistItemsSeen += 1;

    const brandId = findBrand(catalog, item.brand);
    if (!brandId) {
      summary.wishlistItemsSkippedUnknownBrand += 1;
      continue;
    }
    const phoneId = findPhone(catalog, item.brand, item.model);
    if (!phoneId) {
      summary.wishlistItemsSkippedUnknownPhone += 1;
      continue;
    }
    if (seen.has(phoneId)) {
      summary.wishlistItemsSkippedDuplicate += 1;
      continue;
    }
    seen.add(phoneId);
    result.push({ phoneId, addedDate: item.addedAt ?? new Date() });
  }
  return result;
}

/**
 * Filter purchases to those worth inserting. A purchase is "invalid" if it
 * has no date AND no amount AND no label (i.e. an empty stub row). Negative
 * amounts and non-finite numbers are already nulled by the parser.
 *
 * @param {import("./customerGrouper.mjs").CustomerGroup} group
 * @param {ImportSummary} summary
 * @returns {Array}
 */
function resolvePurchases(group, summary) {
  const out = [];
  for (const p of group.purchases) {
    summary.purchasesSeen += 1;
    if (
      p.purchaseDate == null &&
      p.purchaseAmountNpr == null &&
      !p.phoneLabel
    ) {
      summary.purchasesSkippedInvalid += 1;
      continue;
    }
    out.push(p);
  }
  return out;
}

/**
 * Turn the group's browse events into ready-to-insert rows. We try to
 * populate `brandName` for entries that look like a known brand
 * ("Apple", "Samsung", "5G Phones" → null brand, etc.). Events that have
 * neither a label nor a date are skipped as invalid.
 *
 * @param {import("./customerGrouper.mjs").CustomerGroup} group
 * @param {import("./catalogCache.mjs").CatalogCache} catalog
 * @param {ImportSummary} summary
 * @returns {Array<{phoneLabel: string, brandName: string|null, viewedAt: Date|null, sourceLine: number}>}
 */
function resolveBrowseEvents(group, catalog, summary) {
  const out = [];
  for (const e of group.browseEvents) {
    summary.browseEventsSeen += 1;
    if (!e.item && e.eventAt == null) {
      summary.browseEventsSkippedInvalid += 1;
      continue;
    }
    const brandName = findBrand(catalog, e.item) ? e.item : null;
    out.push({
      phoneLabel: e.item,
      brandName,
      viewedAt: e.eventAt,
      sourceLine: e.sourceLine,
    });
  }
  return out;
}

/**
 * Same shape as browse events but routed to SearchHistory. We don't try
 * to derive brand here — the search query is preserved verbatim.
 *
 * @param {import("./customerGrouper.mjs").CustomerGroup} group
 * @param {ImportSummary} summary
 * @returns {Array<{searchQuery: string, searchedAt: Date|null, sourceLine: number}>}
 */
function resolveSearchEvents(group, summary) {
  const out = [];
  for (const e of group.searchEvents) {
    summary.searchEventsSeen += 1;
    if (!e.item && e.eventAt == null) {
      summary.searchEventsSkippedInvalid += 1;
      continue;
    }
    out.push({
      searchQuery: e.item,
      searchedAt: e.eventAt,
      sourceLine: e.sourceLine,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 4: import one customer (transactional).
// ---------------------------------------------------------------------------
async function importOneCustomer(group, catalog, summary, customerRoleId) {
  const email = `${group.customerId}@import.local`;
  const budgetSegment = mapBudgetSegment(
    group.latestPreferredCategory,
    summary._segmentStats,
  );

  const { canonicalNames: preferredBrandsArray, preferredBrandId } =
    resolvePreferredBrands(group, catalog, summary);

  const wishlistCreates = resolveWishlist(group, catalog, summary);
  const validPurchases = resolvePurchases(group, summary);
  const browseCreates = resolveBrowseEvents(group, catalog, summary);
  const searchCreates = resolveSearchEvents(group, summary);

  const password = await generateHashedPassword();
  const hasBudget = group.averageSpendNpr != null && group.averageSpendNpr > 0;
  if (!hasBudget) summary.usersWithZeroBudget += 1;

  // One transaction per customer.
  try {
    return await prisma.$transaction(async (tx) => {
      let user;
      try {
        user = await tx.users.create({
          data: {
            name: group.customerName,
            email,
            password,
            isActive: true,
            isVerified: false,
            roleId: customerRoleId,
          },
          select: { userId: true },
        });
        summary.usersCreated += 1;
      } catch (err) {
        // P2002 = unique constraint violation. Email already taken →
        // idempotent skip. We don't touch this user's existing data.
        if (err?.code === "P2002") {
          summary.usersSkippedExisting += 1;
          return { skipped: true };
        }
        throw err;
      }

      // user_profiles — only insert when at least one demographic field is
      // present. Empty rows add no value and clutter the table.
      if (
        group.age != null ||
        group.gender != null ||
        group.city != null ||
        group.country != null
      ) {
        await tx.userProfile.create({
          data: {
            userId: user.userId,
            age: group.age,
            gender: group.gender,
            city: group.city,
            country: group.country,
          },
        });
      }

      await tx.userPreference.create({
        data: {
          userId: user.userId,
          // The schema requires a non-null budget. We don't have a real
          // maxBudget signal from the CSV; we use averageSpendNpr as the
          // closest available proxy and default to 0 when missing.
          maxBudget: group.averageSpendNpr ?? 0,
          cameraPreference: "Sensible",
          usageType: "Casual",
          preferredBrandId: preferredBrandId ?? undefined,
          // Prefer null over empty array so consumers can use
          // `WHERE preferred_brands IS NOT NULL` cleanly.
          preferredBrands:
            preferredBrandsArray.length > 0 ? preferredBrandsArray : undefined,
        },
      });

      await tx.customerProfile.create({
        data: {
          userId: user.userId,
          budgetSegment: budgetSegment ?? undefined,
          favoriteBrand: preferredBrandsArray[0] ?? null,
          recommendationPersona: "csv-imported",
          segmentConfidence: "provisional",
          searchCount: 0,
          avgBudget: group.averageSpendNpr ?? null,
          totalRecommendations: 0,
          totalComparisons: 0,
          totalWishlist: 0,
        },
      });

      // Wishlist — createMany with skipDuplicates lets the DB enforce
      // @@unique([userId, phoneId]) atomically.
      if (wishlistCreates.length > 0) {
        const inserted = await tx.wishlist.createMany({
          data: wishlistCreates.map((w) => ({
            userId: user.userId,
            phoneId: w.phoneId,
            addedDate: w.addedDate,
          })),
          skipDuplicates: true,
        });
        summary.wishlistItemsImported += inserted.count;
        const duplicates =
          wishlistCreates.length - inserted.count;
        if (duplicates > 0) summary.wishlistItemsSkippedDuplicate += duplicates;
      }

      // Payment history — createMany is one round-trip instead of N.
      if (validPurchases.length > 0) {
        const inserted = await tx.paymentHistory.createMany({
          data: validPurchases.map((p) => ({
            userId: user.userId,
            purchaseDate: p.purchaseDate ?? undefined,
            purchaseAmountNpr: p.purchaseAmountNpr ?? undefined,
            paymentMethod: p.paymentMethod ?? undefined,
            warrantyOpted: p.warrantyOpted ?? undefined,
            exchangeHistory:
              p.exchangeHistory && p.exchangeHistory.length > 0
                ? p.exchangeHistory
                : undefined,
            phoneLabel: p.phoneLabel ?? undefined,
          })),
        });
        summary.paymentRecordsCreated += inserted.count;
        summary.purchasesImported += inserted.count;
      }

      // Browsing history — one row per viewed item, verbatim label.
      if (browseCreates.length > 0) {
        const inserted = await tx.browsingHistory.createMany({
          data: browseCreates.map((e) => ({
            userId: user.userId,
            phoneLabel: e.phoneLabel,
            brandName: e.brandName ?? undefined,
            viewedAt: e.viewedAt ?? undefined,
            sourceLine: e.sourceLine,
          })),
        });
        summary.browseEventsImported += inserted.count;
      }

      // Search history — same source data, routed to a different table.
      if (searchCreates.length > 0) {
        const inserted = await tx.searchHistory.createMany({
          data: searchCreates.map((e) => ({
            userId: user.userId,
            searchQuery: e.searchQuery,
            searchedAt: e.searchedAt ?? undefined,
            sourceLine: e.sourceLine,
          })),
        });
        summary.searchEventsImported += inserted.count;
      }

      return { skipped: false, userId: user.userId };
    });
  } catch (err) {
    summary.errors += 1;
    const msg = `${group.customerId}: ${err?.message ?? String(err)}`;
    if (summary.errorMessages.length < 100) {
      summary.errorMessages.push(msg);
    }
    console.error(`  ! ${msg}`);
    return { skipped: false, error: err };
  }
}

// ---------------------------------------------------------------------------
// Step 0: pre-flight checks
// ---------------------------------------------------------------------------
async function loadCustomerRoleId() {
  const role = await prisma.roles.findUnique({
    where: { roleName: "Customer" },
    select: { roleId: true },
  });
  if (!role) {
    throw new Error(
      "Customer role missing — run `npm run seed:rbac` first.",
    );
  }
  return role.roleId;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const start = Date.now();
  LOG("=== Customer CSV import ===");
  LOG(`CSV: ${CSV_PATH}`);

  if (!fs.existsSync(CSV_PATH)) {
    console.error(`CSV not found: ${CSV_PATH}`);
    process.exit(2);
  }

  LOG("Step 1: reading CSV...");
  const rawRows = readCsv(CSV_PATH);
  LOG(`  read ${rawRows.length} rows`);

  LOG("Step 2: normalizing + grouping...");
  const { groups, summary } = normalizeAndGroup(rawRows);
  LOG(
    `  ${summary.invalidCustomerRows} invalid rows, ${summary.rowWarnings} non-fatal warnings, ${groups.size} unique customers`,
  );

  LOG("Step 3: loading brand/phone catalog...");
  const catalog = await buildCatalogCache(prisma);
  LOG(
    `  catalog: ${catalog.brandNames.size} brands, ${catalog.phoneKeys.size} phones`,
  );

  LOG("Step 4: looking up Customer role...");
  const customerRoleId = await loadCustomerRoleId();
  LOG(`  Customer roleId = ${customerRoleId}`);

  LOG("Step 5: importing customers...");
  // The segment mapper mutates this object directly. We attach it to the
  // summary so the budget-mapper counter and the summary's final shape
  // share the same data.
  summary._segmentStats = newSegmentStats();

  let done = 0;
  for (const group of groups.values()) {
    await importOneCustomer(group, catalog, summary, customerRoleId);
    done += 1;
    if (done % 500 === 0) LOG(`  ...${done}/${groups.size} customers`);
  }
  LOG(`  done: ${done} customers processed`);

  // Move segment stats into the public summary shape.
  summary.budgetSegmentStats = {
    mapped: summary._segmentStats.mapped,
    skipped: summary._segmentStats.skipped,
    byValue: summary._segmentStats.byValue,
  };
  summary.unmappedBudgetCategories = summary._segmentStats.unmappedValues;
  delete summary._segmentStats;

  summary.finishedAt = new Date();
  summary.durationMs = Date.now() - start;

  printSummary(summary);
  await writeReport(summary, REPORT_PATH);
}

main()
  .catch((err) => {
    console.error("Import failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
