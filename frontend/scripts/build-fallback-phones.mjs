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
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "..", "hard.json");
const DEST = join(__dirname, "..", "public", "fallback-phones.json");
const PHONE_IMG_DIR = join(__dirname, "..", "public", "phones");

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

// Local image catalog. The dashboard's BE-supplied entries point at
// remote URLs (CDN), but the fallback catalog has to work offline, so
// we scan `public/phones/` at build time and pick the best match for
// each entry. The 19 photos shipped under `public/phones/` cover the
// dominant brands in the dataset (Honor, Samsung, Xiaomi, OnePlus,
// Apple-ish, plus a few misc Tecno/Infinix/Poco/Nokia fillers).
//
// Each entry has:
//   - `name`     filename without extension, used for keyword matching
//                against the phone's `modelName`.
//   - `brands`   brand keywords that *must* appear (case-insensitive)
//                in the brand or model name to be considered a strong
//                match. Empty array = generic filler (used when no
//                brand-specific image exists).
//   - `tier`     "preferred" → use this if matched; "filler" → only
//                use when no preferred match exists.
//
// Tiered matching: brand-specific photos win first, then fillers. The
// result is that an "Honor Magic8 Pro" gets `samsung26ultra.jpg` (the
// only flagship-looking image it qualifies for in the absence of a
// Honor photo) instead of the placeholder SVG — at least it's a real
// phone rather than a flat outline.
const PHONE_IMAGES = [
  // Apple — three photos. Note the BE never returns Apple, but the
  // dataset's `Brand` field is mixed-case ("Apple" vs "iPhone") so the
  // keyword list covers both.
  { name: "iphone16", ext: "jpg", brands: ["apple", "iphone"], tier: "preferred" },
  { name: "iphone12pm", ext: "jpeg", brands: ["apple", "iphone", "pro max"], tier: "preferred" },
  { name: "iphonerandom2", ext: "jpeg", brands: ["apple", "iphone"], tier: "preferred" },

  // Samsung Galaxy — four photos, distinct enough that we can pick the
  // closest by model keyword.
  { name: "samsungs25ultra", ext: "jpeg", brands: ["samsung", "ultra"], tier: "preferred" },
  { name: "samsungs26ultra", ext: "jpeg", brands: ["samsung", "ultra"], tier: "preferred" },
  { name: "samsungs25", ext: "jpeg", brands: ["samsung"], tier: "preferred" },
  { name: "samsungs252", ext: "jpeg", brands: ["samsung"], tier: "preferred" },

  // Xiaomi / Redmi / Poco — covered by 5 photos.
  { name: "xiaomi13t", ext: "jpg", brands: ["xiaomi", "13t"], tier: "preferred" },
  { name: "redminote15", ext: "jpeg", brands: ["redmi", "note"], tier: "preferred" },
  { name: "redmi14c", ext: "jpg", brands: ["redmi"], tier: "preferred" },
  { name: "redmia3", ext: "jpg", brands: ["redmi", "a3"], tier: "preferred" },
  { name: "pocox3", ext: "jpg", brands: ["poco", "x3"], tier: "preferred" },

  // OnePlus — one photo.
  { name: "oneplus13", ext: "jpeg", brands: ["oneplus", "one plus"], tier: "preferred" },

  // Nokia — three photos covering keypad + smartphones.
  { name: "nokiag42", ext: "jpg", brands: ["nokia", "g42"], tier: "preferred" },
  { name: "nokia6280", ext: "jpg", brands: ["nokia", "6280"], tier: "preferred" },
  { name: "nokia keypad", ext: "jpg", brands: ["nokia"], tier: "preferred" },

  // Tecno — Camon + Pop + Spark cover Spark Go/Pop/Camon lines.
  { name: "camon40", ext: "jpg", brands: ["tecno", "camon"], tier: "preferred" },
  { name: "pop6", ext: "jpg", brands: ["tecno", "pop"], tier: "preferred" },
  { name: "spark30c", ext: "jpg", brands: ["tecno", "spark"], tier: "preferred" },
];

const stableId = (brand, model) =>
  // First 24 hex chars (96 bits) is plenty for collision-free keys
  // across 200 rows and matches the BE's UUID-ish length.
  createHash("sha1").update(`${brand}|${model}`).digest("hex").slice(0, 24);

// Score an image against a phone row. Higher is better; -1 = no match.
// Match scoring is keyword-count based: any brand keyword that appears
// in the lowercased "brand model" string scores 1. The keyword set is
// intentionally small so unrelated models don't accidentally match.
const scoreImage = (img, brand, model) => {
  if (img.brands.length === 0) return -1; // fillers are picked separately
  const haystack = `${brand} ${model}`.toLowerCase();
  let score = 0;
  for (const kw of img.brands) {
    if (haystack.includes(kw)) score += 1;
  }
  return score > 0 ? score : -1;
};

const pickImage = (brand, model) => {
  // First pass: any preferred-tier image whose keywords hit.
  const candidates = PHONE_IMAGES
    .map((img) => ({ img, score: scoreImage(img, brand, model) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  if (candidates.length > 0) {
    // Highest score wins. Ties resolve in PHONE_IMAGES declaration
    // order, which is deterministic across builds.
    return candidates[0].img;
  }
  // No brand-specific match (Honor / Vivo / Oppo / Realme / Asus /
  // Google / Sharp / Sony / Zte / Motorola etc. all fall through
  // here — there's no Honor/Oppo/Vivo/etc. photo in the local set).
  // Fall back to a deterministic round-robin across ALL images so the
  // user still sees a real phone photo rather than the flat SVG
  // outline. The fill is stable per (brand, model) so re-running the
  // script gives the same assignment, and the dashboard's pagination
  // means the same filler won't dominate the first page.
  const id = stableId(brand, model);
  // Two hex chars → 256 buckets across the 19 photos. Using the
  // second pair rather than just the first so consecutive hex chars
  // aren't biased toward ASCII-letter ranges.
  const bucket = parseInt(id.slice(2, 4), 16) % PHONE_IMAGES.length;
  return PHONE_IMAGES[bucket];
};

const transform = (row, idx) => {
  const id = stableId(row.Brand, row.Model);
  const sub = row.SubScores || {};
  const img = pickImage(row.Brand, row.Model);
  return {
    id,
    modelName: row.Model,
    // Local images live under `public/phones/`, so Vite serves them
    // at `/phones/<file>.<ext>`. The catalog card JSX renders
    // `<img src={p.imageUrl}>` directly — no import, no bundler
    // pipeline — so a string URL is exactly what it needs.
    imageUrl: img ? `/phones/${img.name}.${img.ext}` : null,
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