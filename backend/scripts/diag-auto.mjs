// FAST AUTO check — bypasses the ML service by calling the pure
// fusionRank directly with a candidate set pulled from the DB.
// Surfaces the customer_preference component per candidate so we can
// see whether the new-era iPhone 17 / iPad Air rows actually rank.
//
// Usage: TARGET_USER_ID=<uuid> node scripts/diag-auto.mjs [out.json]
import { prisma } from "../src/config/prisma.mjs";
import fs from "node:fs";
import { personalizedRank } from "../src/services/fusionRanker.mjs";
import { loadBehaviorScoreMap } from "../src/services/profileService.mjs";

const userId = process.env.TARGET_USER_ID;
const out = process.argv[2] || `scripts/auto-${userId}.json`;
if (!userId) {
  console.error("Need TARGET_USER_ID");
  process.exit(2);
}

const behaviorScores = await loadBehaviorScoreMap(userId);
console.log("BEHAVIOR_SCORES_MAP_SIZE", behaviorScores.size);

// Pull ALL active phones so the user's affinity tags can hit their
// targets. None of the ranker's ML-side sub-scores live on the
// Phones Prisma model (they come from the Python service); for this
// diagnostic we set them all to a neutral 0.5 so the only varying
// component across candidates is `customer_preference`, which is
// exactly what we want to measure.
const phones = await prisma.phones.findMany({
  where: { isActive: true },
  select: {
    phoneId: true,
    modelName: true,
    brand: { select: { name: true } },
  },
});

const candidates = phones.map((p) => ({
  id: p.phoneId,
  phoneId: p.phoneId,
  modelName: p.modelName,
  brand: p.brand?.name,
  tier: null,
  tags: [],
  overallScore: 50, // → compatibility = 0.5
  contentSim: 0.5,
  valueScore: 50, // → value = 0.5
  trendScore: 0.5,
  freshness: 0.5,
}));

const t0 = Date.now();
const ranked = personalizedRank(candidates, behaviorScores, new Map(), new Map());
console.log(`personalizedRank took ${Date.now() - t0}ms for ${candidates.length} candidates`);

// Per-candidate: pull their behaviorScores subset, plus fused components.
const targetTagsForCandidate = (c) => {
  const tags = [];
  // affinity for this phone
  tags.push(`affinity:${c.phoneId}`);
  // brand (lowercased)
  if (c.brand) tags.push(`brand:${c.brand.toLowerCase()}`);
  // tier
  if (c.tier) tags.push(`tier:${c.tier.toLowerCase()}`);
  // features
  for (const t of ["feature:gaming","feature:camera","feature:battery","feature:performance","feature:display"]) tags.push(t);
  return Object.fromEntries(
    tags.map((t) => [t, behaviorScores.get(t) ?? null]),
  );
};

// Print top-15
const top = ranked.slice(0, 15).map((r) => ({
  phoneId: r.phoneId,
  modelName: r.modelName,
  brand: r.brand,
  finalScore: r.finalScore,
  customerPreference: r.components?.customer_preference ?? null,
  compatibility: r.components?.compatibility ?? null,
  contentSim: r.components?.content_similarity ?? null,
  searchHistory: r.components?.search_history ?? null,
  value: r.components?.value ?? null,
  freshnessTrending: r.components?.freshness_trending ?? null,
  relevantScores: targetTagsForCandidate(r),
}));

const payload = {
  userId,
  at: new Date().toISOString(),
  behaviorScoresRowCount: behaviorScores.size,
  candidateCount: candidates.length,
  top,
};
fs.writeFileSync(out, JSON.stringify(payload, null, 2), "utf8");

console.log("TOP15:");
for (const r of top) {
  console.log(
    `  fs=${r.finalScore.toFixed(4)} cp=${r.customerPreference?.toFixed(4)} ` +
    `${r.brand} ${r.modelName}`,
  );
}

// Specific check: where does iPhone 17 / iPad Air 13 land?
const wants = ["Apple iPhone 17", "Apple iPhone 17e", "Apple iPad Air 13 (2026)", "Apple iPad Air 11 (2026)"];
for (const w of wants) {
  const row = ranked.find((r) => r.modelName === w);
  if (!row) {
    console.log(`(not in candidate set) ${w}`);
    continue;
  }
  const idx = ranked.indexOf(row);
  console.log(`RANK #${idx + 1} ${row.modelName} fs=${row.finalScore.toFixed(4)} cp=${row.components?.customer_preference?.toFixed(4)}`);
}

await prisma.$disconnect();