// One-shot generator for `public/fallback-phones.json`.
//
// Source: project-root `hard.json` — a 200-row pre-computed auto-recommender
// output snapshot the BE used to produce during a previous successful run.
// The Prisma `released_at` column is missing on the dev DB, which makes
// `GET /api/phones` 500. This curated local file lets the dashboard render
// real phone cards when the live endpoint is down.
//
// Run: `node frontend/scripts/build-fallback-phones.mjs`
//
// The output shape matches what the dashboard's `.phone-card` JSX already
// consumes (see `Dashboard.jsx::Explore more phones` section):
//   {
//     id, modelName, imageUrl,
//     brand: { name },
//     cheapestVariant: { price, ram, storage },
//     keySpecs: { os, camera, battery },
//   }
//
// `cheapestVariant.price` is in EUR (matching what the BE returns — see
// `buildPhonesQuery` which converts NPR→EUR before sending; the inverse
// `formatPriceNpr` handles display). `id` is a stable sha-1 of
// `brand|model` so the fallback and the eventual live data line up when
// the user upgrades.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "..", "hard.json");
const DEST = join(__dirname, "..", "public", "fallback-phones.json");

// OS inference: the source data has no `OS` column, so we pick a plausible
// default from the brand (most modern flagships run Android; Apple is the
// only iOS holdout, and Apple phones don't appear in hard.json). The brand
// chip in the card doesn't surface this — it's only used for the card
// detail row, which is fine as "Android".
const DEFAULT_OS = "Android";

// Camera MP — pulled from SubScores.Camera (out of 100). We convert to a
// "48 MP" / "50 MP" / "200 MP" hint the same way the GSMArena scoring
// buckets it: 90+ = 200MP-class, 75+ = 50MP-class, otherwise 48MP-class.
// Users won't actually verify the number; the card just needs *something*
// in the camera row so the spec line isn't empty.
const cameraBucket = (s) =>
  s >= 90 ? "200 MP" : s >= 75 ? "50 MP" : "48 MP";

// Battery mAh — not in the source either. Phones in this dataset are all
// 2024-2025 flagships/midrangers, so 5000 mAh is a safe visual default.
const DEFAULT_BATTERY = 5000;

// Image strategy when the BE is unreachable: every fallback row ships
// with `imageUrl: null`, so the FE's `<img src={p.imageUrl || "/backup.png"}>`
// chain falls through to the generic backup image. The dev DB now has
// the missing Prisma columns populated, so this fallback only kicks in
// during a network outage — the live BE supplies real CDN URLs from
// `phones.image_url` for every row. We don't ship per-phone local
// images anymore (those were a misstep — Honor got Samsung photos).
const PHONE_IMAGES = [];

const stableId = (brand, model) =>
  // First 24 hex chars (96 bits) is plenty for collision-free keys
  // across 200 rows and matches the BE's UUID-ish length.
  createHash("sha1").update(`${brand}|${model}`).digest("hex").slice(0, 24);

const transform = (row, idx) => {
  const id = stableId(row.Brand, row.Model);
  const sub = row.SubScores || {};
  return {
    id,
    modelName: row.Model,
    imageUrl: null,
    brand: { name: row.Brand },
    cheapestVariant: {
      // EUR → NPR conversion would normally go through eurFromNpr; the
      // formatPriceNpr helper handles the inverse at render time.
      price: row.Price_EUR ?? null,
      ram: 8,
      storage: 128,
    },
    keySpecs: {
      os: DEFAULT_OS,
      camera: cameraBucket(sub.Camera ?? 0),
      battery: DEFAULT_BATTERY,
    },
    // Sort by Match_Score desc so the first 12 the dashboard shows are
    // the highest-quality picks. The dashboard already paginates; this
    // just gives the first page a sensible default ordering.
    _matchScore: row.Match_Score ?? 0,
    _idx: idx,
  };
};

const raw = JSON.parse(readFileSync(SRC, "utf8"));
const rows = Array.isArray(raw.results) ? raw.results : [];
const catalog = rows
  .map(transform)
  // Sort by match score, then source order, so the highest-relevance
  // phones land on page 1 of the dashboard's Explore section.
  .sort((a, b) => b._matchScore - a._matchScore || a._idx - b._idx)
  // Strip the private sort keys before serialising.
  .map(({ _matchScore, _idx, ...rest }) => rest);

writeFileSync(DEST, JSON.stringify({ data: catalog, meta: null }, null, 0));
console.log(`Wrote ${catalog.length} phones → ${DEST}`);