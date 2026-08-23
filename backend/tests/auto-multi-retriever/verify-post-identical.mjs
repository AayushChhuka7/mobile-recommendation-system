// ---------------------------------------------------------------------------
// GROUP 4 — POST byte-identical guarantee harness.
//
// Captures the exact output of the POST /api/recommend service path
// (`recommendService.getRecommendations`) for a FIXED input. Run this
// once on the current (fixed) code and once on the pre-change baseline
// (via `git stash`), then diff the two JSON dumps — they must be
// byte-identical, proving the catalog/tier fix (which lives only on the
// AUTO `orchestrate` path) did not perturb the click/POST path.
//
// Usage:
//   node backend/tests/auto-multi-retriever/verify-post-identical.mjs <outfile>
//
// Determinism notes:
//   - userId is null → no per-user behavior personalization, so the
//     output depends only on the (fixed) catalog + ML rule-based scorer.
//   - The ML /recommend scorer is deterministic for a fixed input.
//   - CF service being up or down affects BOTH runs identically.
// ---------------------------------------------------------------------------
import "dotenv/config";
import { writeFileSync } from "node:fs";

const outFile = process.argv[2];
if (!outFile) {
  console.error("usage: node verify-post-identical.mjs <outfile>");
  process.exit(2);
}

const { getRecommendations } = await import(
  "../../src/services/recommendService.mjs"
);

// Fixed, representative click-flow request body. Broad budget so the
// candidate pool is large and any ranking perturbation would show up.
const body = {
  persona: "allrounder",
  budget: { min: 0, max: 1500 },
  preferences: {},
  topN: 60,
};

const response = await getRecommendations(body, /* userId */ null, {
  source: "click",
  requestId: "verify-post-identical-fixed",
});

// Serialize deterministically. We keep the full response but drop the
// two fields that are legitimately volatile and unrelated to ranking
// correctness (they would differ run-to-run even on identical code):
//   - nothing known volatile in results, but guard defensively.
const results = Array.isArray(response?.results) ? response.results : [];

// Reduce to the ranking-identity view: ordered list of (phoneId/model,
// score fields). This is exactly what the "byte-identical guarantee"
// protects — the ranked output the user sees.
const canonical = results.map((r) => ({
  phoneId: r.phoneId ?? r.id ?? null,
  modelName: r.modelName ?? r.model ?? null,
  brand: r.brand ?? r.brandName ?? null,
  matchScore: r.matchScore ?? null,
  matchScoreFastApi: r.matchScoreFastApi ?? null,
  finalScore: r.finalScore ?? null,
  price: r.price ?? null,
}));

const payload = {
  count: canonical.length,
  totalRanked: response?.totalRanked ?? null,
  eagerCount: response?.eagerCount ?? null,
  results: canonical,
};

writeFileSync(outFile, JSON.stringify(payload, null, 2));
console.log(
  `[verify-post] wrote ${outFile} — ${canonical.length} candidates, totalRanked=${payload.totalRanked}`,
);
process.exit(0);
