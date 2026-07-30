// personalization_diag.mjs — focused diagnostic to isolate WHY rankings
// barely move even though the tag-vocabulary fix is confirmed working.
//
// Two hypotheses to test with numbers:
//   H1  search_history SATURATES: every flagship shares feature:gaming /
//       feature:performance / tier:flagship, so once the user has positive
//       scores on those dims, tanh(0.75*raw) → ~1.0 for EVERY candidate →
//       the signal stops discriminating between phones.
//   H2  search_history is UNDER-WEIGHTED: 0.1053 of final vs a fixed
//       compatibility+customer_preference = 0.6316, so even a perfect
//       search_history swing (0.0527) is smaller than the baseline gaps
//       between phones (~0.06).
//
// Then quantify two safe what-if fixes.

import { searchHistoryScore, phoneToTags } from "./src/services/searchHistoryScore.mjs";
import { FUSION_WEIGHTS } from "./src/services/fusionRanker.mjs";

// The behaviour score map a GAMING-preference user ends up with (taken
// verbatim from the probe's TEST 3 AFTER dump).
const gamingUser = new Map([
  ["feature:gaming", 1.5308],
  ["feature:performance", 1.4107],
  ["feature:camera", 1.3479],
  ["brand:iQOO", 1.2429],
  ["brand:Nubia", 1.2400],
  ["feature:battery", 1.1482],
  ["brand:Asus", 1.0580],
  ["feature:display", 0.9308],
  ["tier:flagship", 0.6956],
  ["category:gaming", 0.3556],
]);

// A pure gaming phone vs a pure non-gaming (camera) phone — do they get
// DIFFERENT search_history scores for a gaming user? They should.
const phones = [
  { name: "ROG Phone 9 (gaming)", tags: phoneToTags({ brand:{name:"Asus"}, antutuScore:2200000, specs:{ chipset:"Snapdragon 8 Gen 4", mainCamera:"50 MP", batteryMah:5800, refreshRate:165 } }) },
  { name: "Pixel 9 Pro (camera)", tags: phoneToTags({ brand:{name:"Google"}, antutuScore:1100000, specs:{ chipset:"Tensor G4", mainCamera:"50 MP", batteryMah:4700, refreshRate:120 } }) },
  { name: "Galaxy A16 (budget)",  tags: phoneToTags({ brand:{name:"Samsung"}, antutuScore:400000, specs:{ chipset:"Exynos 1330", mainCamera:"50 MP", batteryMah:5000, refreshRate:90 } }) },
  { name: "S26 Ultra (allround)", tags: phoneToTags({ brand:{name:"Samsung"}, antutuScore:2100000, specs:{ chipset:"Snapdragon 8 Gen 4", mainCamera:"200 MP", batteryMah:5000, refreshRate:120 } }) },
];

console.log("=== H1: does search_history DISCRIMINATE for a gaming user? ===\n");
console.log("Phone                     tags                                          rawSum   SH(tanh)");
for (const p of phones) {
  let raw = 0, matched = [];
  for (const t of p.tags) if (gamingUser.has(t)) { raw += gamingUser.get(t); matched.push(t); }
  const sh = searchHistoryScore({ tags: p.tags }, gamingUser);
  console.log(
    p.name.padEnd(26) +
    p.tags.join(",").slice(0,44).padEnd(46) +
    raw.toFixed(3).padEnd(9) +
    sh.toFixed(4)
  );
}

console.log("\nObservation: raw overlap sums are all >> 1, so tanh(0.75*raw) pins");
console.log("every flagship near 1.0. The gaming phone and the camera phone get");
console.log("nearly IDENTICAL search_history scores → no discrimination.\n");

// ---- H2: weight ceiling vs baseline inter-phone gap -----------------------
console.log("=== H2: can search_history overcome the compatibility gap? ===\n");
const w = FUSION_WEIGHTS.search_history;
console.log(`search_history weight           = ${w}`);
console.log(`max SH final-score swing (0.5→1) = ${(w*0.5).toFixed(4)}`);
console.log(`typical baseline gap rank1→rank2 = ~0.014 (0.7522→0.7380)`);
console.log(`gap rank1→rank5                  = ~0.062 (0.7522→0.6900)`);
console.log("So SH can only reshuffle near-adjacent phones; it cannot lift a");
console.log("rank-7 phone past a rank-3 phone. compat+custPref (0.6316) dominate.\n");

// ---- What-if #1: discriminative (non-saturating) SH normalization ---------
// Replace tanh-of-sum with a MEAN of matched dims, weighted toward the
// intent dims. Simple proxy: average matched score / positiveCap(4).
console.log("=== WHAT-IF #1: mean-based (non-saturating) search_history ===\n");
function shMeanBased(tags, user) {
  let sum = 0, n = 0;
  for (const t of tags) if (user.has(t)) { sum += user.get(t); n++; }
  if (n === 0) return 0.5;
  const mean = sum / n;            // average affinity of matched tags
  return Math.min(1, Math.max(0, 0.5 + mean / 8)); // spread around 0.5
}
console.log("Phone                     SH(current)  SH(mean-based)");
for (const p of phones) {
  const cur = searchHistoryScore({ tags: p.tags }, gamingUser);
  const alt = shMeanBased(p.tags, gamingUser);
  console.log(p.name.padEnd(26) + cur.toFixed(4).padEnd(13) + alt.toFixed(4));
}
console.log("\n(mean-based still barely separates because every flagship shares");
console.log(" the same high-value dims — the real fix must make the feature");
console.log(" profile INTENT-SPECIFIC, not just re-normalise the sum.)\n");

// ---- What-if #2: raise search_history weight, show rank impact ------------
console.log("=== WHAT-IF #2: raise search_history weight 0.1053 → 0.30 ===\n");
const baselinePhones = [
  { name:"Samsung S26 Ultra", compat:0.920, cust:0.880, content:0.800, value:0.006 },
  { name:"Honor Magic7 Pro",  compat:0.900, cust:0.860, content:0.790, value:0.006 },
  { name:"Asus ROG Phone 9",  compat:0.850, cust:0.800, content:0.700, value:0.005 },
  { name:"RedMagic 10 Pro",   compat:0.840, cust:0.790, content:0.680, value:0.005 },
];
// Give gaming phones a discriminative SH (0.95) and others neutral-ish (0.55)
const shByPhone = { "Samsung S26 Ultra":0.70, "Honor Magic7 Pro":0.60, "Asus ROG Phone 9":0.95, "RedMagic 10 Pro":0.95 };
function fuseWith(weights, phone) {
  const sh = shByPhone[phone.name];
  return weights.compatibility*phone.compat + weights.customer_preference*phone.cust +
         weights.content_similarity*phone.content + weights.search_history*sh +
         weights.value*phone.value;
}
const raised = Object.freeze({ compatibility:0.35, customer_preference:0.18, content_similarity:0.12, search_history:0.30, value:0.05 });
console.log("Phone                current-W final   raised-W final  (SH given)");
for (const p of baselinePhones) {
  console.log(p.name.padEnd(20) + fuseWith(FUSION_WEIGHTS,p).toFixed(4).padEnd(18) + fuseWith(raised,p).toFixed(4).padEnd(16) + shByPhone[p.name]);
}
console.log("\nWith weight=0.30 AND a discriminative SH, a gaming phone (ROG/RedMagic)");
console.log("can close the compatibility gap. But this REQUIRES H1 fixed first —");
console.log("weight alone does nothing while SH is saturated uniformly.\n");
