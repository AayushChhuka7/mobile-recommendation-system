# Customer CSV Import

Imports `dataset/customer_dataset.csv` into the existing Prisma schema **without polluting the phone catalog**.

## What it does

For each unique `customer_id` in the CSV it creates:

| Table | What is written |
|---|---|
| `users` | One row. `email = ${customer_id}@import.local`. Secure random password (bcrypt, cost 10). `isVerified = false`. `roleId` = Customer. |
| `user_profiles` | `age`, `gender`, `city`, `country` (latest row per customer). |
| `user_preferences` | `maxBudget` from `average_spend_npr`, `preferredBrandId` from the first preferred brand that exists in the catalog, **plus** a `preferredBrands` JSONB array with the full unique set (canonicalized to DB brand names where possible). |
| `customer_profile` | `budgetSegment` (mapped from `preferred_category`), `favoriteBrand`, `avgBudget`, `segmentConfidence = provisional`. |
| `wishlist` | One row per unique `<brand, model>` that **already exists** in the existing `brands` and `phones` tables. Inserted with `createMany({ skipDuplicates: true })` so the unique constraint on `(userId, phoneId)` is enforced atomically. |
| `payment_history` | One row per CSV purchase event (purchaseDate, amount NPR, payment method, warranty, exchange history, phone label). Inserted with `createMany` in a single round-trip per customer. |
| `browsing_history` | One row per `browsing_history` CSV entry (raw label, derived brand name when the item matches a known brand, viewed-at timestamp, source line). Inserted with `createMany`. No FK to `Phones` — fictional/future/tablet entries are preserved verbatim. |
| `search_history` | One row per `browsing_history` CSV entry (the same array, used as the "search" signal per the chosen mapping). Inserted with `createMany`. |

## What it does NOT do (per spec)

- Never creates `Brands`.
- Never creates `Phones`.
- Never creates `PhoneSpecs`.
- Never creates `PhoneVariants`.
- Wishlist items whose brand or model is missing from the catalog are silently dropped and counted in the summary.
- Browsing and Search history are preserved as raw labels — no canonicalization against the catalog is performed (only `brandName` is filled when the entry happens to match a known brand).

## How to run

```bash
# 1. Make sure migrations are applied:
npx prisma migrate deploy

# 2. Run the import (default path: ../../dataset/customer_dataset.csv):
npm run seed:customers

# Or with a custom CSV path:
node prisma/imports/customer-csv/importCustomers.mjs /path/to/customer_dataset.csv
```

## Idempotency

The script is **idempotent on customer email**. Re-running it:

- Skips customers whose `${customerId}@import.local` already exists. The check happens **inside** the per-customer transaction (via the `users.email` unique constraint, not a pre-flight `findUnique`), so two parallel runs cannot both insert the same customer.
- Does **not** re-process their wishlist, payment history, browsing history, or search history. If you want a full re-import, delete the existing rows first (e.g. `DELETE FROM users WHERE email LIKE '%@import.local';`).

The script does **not** re-create Brands or Phones. If the catalog changes, the next run picks up the new lookups automatically.

## Output

Two artifacts:

1. **Console summary** — printed at the end of the run.
2. **`prisma/imports/customer-csv/import-report.json`** — same shape, persisted for CI / audit.

Example summary:

```
────────────────────────────────────────────────────────────────────────
  IMPORT SUMMARY
────────────────────────────────────────────────────────────────────────
  CSV                              .../dataset/customer_dataset.csv
  Duration                         12.34s

  — Input —
  Total rows                       16608
  Invalid customer rows            0
  Non-fatal row warnings           14

  — Customers —
  Unique customers                 4152
  Users created                    4152
  Users skipped (already exist)    0
  Users with zero maxBudget        0

  — Wishlist —
  Items seen                       20760
  Items imported                   1100
  Skipped — unknown brand          18520
  Skipped — unknown phone          1040
  Skipped — duplicate (user,phone) 0
  Skipped — invalid item           0

  — Payments —
  Purchases seen                   16608
  Purchases imported               16608
  Purchases skipped (invalid)      0
  PaymentHistory rows created      16608

  — Browsing History —
  Events seen                      170000
  Events imported                  170000
  Events skipped (invalid)         0

  — Search History —
  Events seen                      170000
  Events imported                  170000
  Events skipped (invalid)         0

  — Budget segments —
  Mapped / Skipped                 16608 / 0
────────────────────────────────────────────────────────────────────────
```

(Exact numbers depend on the catalog state. Most wishlist items are
skipped because the CSV references fictional/future phones like
"Apple iPhone 17 Pro Max" that don't exist in the existing catalog.)

## File layout

```
prisma/imports/customer-csv/
├── README.md
├── importCustomers.mjs     # main entrypoint
├── csvParser.mjs           # row-by-row normalization + strict validation
├── customerGrouper.mjs     # group by customer_id + latest-wins
├── catalogCache.mjs        # in-memory brand+phone lookup, incl. canonical names
├── budgetSegmentMapper.mjs # preferred_category → BudgetSegment
├── passwordHash.mjs        # secure random password + bcrypt
└── reporter.mjs            # summary + JSON report writer
```

## Behavioral data (browsing + search history)

The CSV's `browsing_history` column is a JSON array of `{item, viewed_at}` entries. The item can be:

- a brand name (`Apple`, `Samsung`, `Xiaomi`, ...)
- a category tag (`Cases & Covers`, `Flagship Phones`, `Camera Phones`, `5G Phones`, `Gaming Phones`, ...)
- a meta-action (`Comparison`, `New Arrivals`, `Accessories`, `Laptops`, ...)

The importer routes these entries into two tables:

| Source field | Target table | Mapping |
|---|---|---|
| `browsing_history[*].item` | `browsing_history.phone_label` | verbatim |
| `browsing_history[*].viewed_at` | `browsing_history.viewed_at` | parsed as UTC |
| `browsing_history[*].item` (if matches a known brand) | `browsing_history.brand_name` | null otherwise |
| `browsing_history[*].item` | `search_history.search_query` | verbatim |
| `browsing_history[*].viewed_at` | `search_history.searched_at` | parsed as UTC |

Both tables are populated from the **same** `browsing_history` array because the CSV has no separate `search_history` column. If you later add one, the `resolveSearchEvents` helper in `importCustomers.mjs` is the single place to change.

**Dedup rule (per spec)**: entries are deduped only within the same CSV row (case-insensitive on `item`). Repeated views/searches across rows are kept because they represent real user behavior.

**Why no FK to `Phones`**: the entries include fictional, future, and tablet models that don't exist in the catalog. We follow the same philosophy as `PaymentHistory.phone_label` — preserve the raw string for downstream analytics.

**Timezone**: `viewed_at` / `searched_at` are wall-clock values with no timezone. They are parsed as UTC so the import is deterministic regardless of the host machine's local time.

## Data-quality notes / known limitations

- **Tablets** (e.g. "Apple iPad Pro 11 (2025)", "Samsung Galaxy Tab S9 Ultra") are recorded in `payment_history` as `phone_label` strings but do not become `Phones` rows. The wishlist lookup will skip them because the catalog is phones-only.
- **Fictional / future models** ("iPhone 17 Pro Max", "iPhone 17e", "OnePlus 13s", "Xiaomi 17 Max", etc.) are intentionally not added to the catalog. Wishlist entries referencing them are skipped, but the purchase itself is still recorded.
- **Currency mismatch**: CSV is in NPR; the existing phone catalog uses USD. The script records `purchase_amount_npr` in `payment_history` for audit; `maxBudget` / `avgBudget` are written as-is and would need FX conversion before being fed to the recommender. We do not silently change currency.
- **Stable-field conflict resolution**: the row with the most recent timestamp wins. Recency is `max(lastActiveAt, purchaseDate)` so a row with no `lastActiveAt` can still be "latest" if its purchase is the most recent. `preferredBrands` is the deliberate exception: it accumulates, never overwrites.
- **preferred_category vs BudgetSegment**: the CSV's vocabulary (Gaming, Foldable, 5G Phones, Battery-focused, Compact Phones) is a feature descriptor, not a price tier. We map the four true price tiers and leave the rest as `null` so the recommender doesn't get a wrong signal. The unmapped values are printed in the summary for later refinement.
- **Auth state**: imported users are `isVerified = false` and have a random password no one knows. They cannot log in until the password is reset through the existing flow.
- **Search history source**: the CSV has no dedicated search column, so `search_history` is populated from `browsing_history` per the chosen mapping. To use a real search column, add it to the CSV and update `resolveSearchEvents` in `importCustomers.mjs`.
- **preferredBrands canonicalization**: brand strings from the CSV are looked up case-insensitively against the `brands` table. If a match is found, the DB-canonical name is stored. If not, the raw CSV value is preserved (so the signal isn't lost) and a sample is added to `preferredBrandsUnmatched` in the report.
- **Strict validation in `csvParser`**: amounts must be non-negative finite numbers, ratings must be 1..5, ages must be 0..120, JSON columns must be arrays, dates must parse. Failing fields are nulled and a warning is recorded. Missing `customer_id` / `customer_name` is a hard error that skips the entire row.

## Recent improvements (vs. v1)

1. Validation hardened: amount/rating/age/date/JSON strictness added.
2. Idempotency enforced via the `users.email` unique constraint inside the transaction — no pre-flight `findUnique`, no race window.
3. Wishlist and payment inserts switched to `createMany` (single round-trip per customer) with `skipDuplicates` on wishlist to honor `@@unique([userId, phoneId])` without a try/catch.
4. Latest-wins rule now uses `max(lastActiveAt, purchaseDate)` for recency, and renames `preferredCategory` (row) → `latestPreferredCategory` (group) correctly.
5. Preferred brand strings are canonicalized to DB brand names where possible; unknown brands are kept (not silently dropped) and sampled in the report.
6. Summary expanded: separate counts for invalid rows, non-fatal warnings, zero-budget users, duplicate (user,phone) wishlist attempts, unmatched preferred brands, and unmapped budget categories.
7. Latent bug fixed: `LATEST_WINS_FIELDS` was a flat string array of group-field names but one of them (`latestPreferredCategory`) had a different name on the row. Renamed to `[groupField, rowField]` pairs.
8. Added `SearchHistory` and `BrowsingHistory` tables, both populated from the CSV's `browsing_history` array. `createMany` per customer; per-row dedup only; wall-clock timestamps parsed as UTC to stay timezone-independent.
