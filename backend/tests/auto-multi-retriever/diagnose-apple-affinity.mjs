// One-off diagnostic: trace Apple's path through the multi-retriever
// pipeline for user b7e58b7d-... to find why Apple phones don't appear
// in their AUTO recommendations.

import "dotenv/config";
import { orchestrate } from "../../src/services/autoMultiRetriever.mjs";
import { personalizedRank } from "../../src/services/fusionRanker.mjs";
import {
  loadBehaviorScoreMap,
  getRecentEvents,
  loadPhoneMetaMap,
} from "../../src/services/profileService.mjs";
import { buildShortTermInterest } from "../../src/services/shortTermInterest.mjs";

const userId = "b7e58b7d-8472-4710-87bb-6d6f53bfce66";
const appleIds = new Set([
  "fa8c3f6a-5be9-46e1-80e3-4a1ebfeab36c", // iPhone 17e
  "1fd8a75f-f7ef-4203-a212-ccc5b3238897", // iPhone 17
  "aa180e35-9c96-464b-8de8-9d406fd159e3", // iPhone 17 Pro Max
  "52fa6bec-1b16-4be2-ad8d-26acd08ba02c", // iPhone Air
  "3684c204-9266-4eb7-974c-367f1d0a957b", // iPhone 16 Pro
  "1272fcee-77ff-45d4-9843-ae8b65d81ce7", // iPhone 12 Pro
  "4446af2b-eaaa-4a34-8c4d-01812fdff94c", // iPad Air 13 (2026)
  "98aa7344-9e65-428c-af66-1fc87843234a", // iPad Air 11 (2026)
]);

const orchestrated = await orchestrate(userId, {
  requestId: "diagnose-apple-trace",
  persona: "gamer",
  budget: { min: 0, max: 1149.43 },
});

const behaviorScoresMap = await loadBehaviorScoreMap(userId);
const recentEvents = await getRecentEvents(userId);
const candidateMetaMap = recentEvents.length > 0
  ? await loadPhoneMetaMap([
      ...recentEvents.map((e) => e.phoneId).filter(Boolean),
      ...orchestrated.candidates.map((c) => c.id).filter(Boolean),
    ])
  : new Map();
const interestVec = recentEvents.length > 0
  ? buildShortTermInterest(recentEvents, candidateMetaMap)
  : new Map();

console.log("recentEvents count:", recentEvents.length, "interestVec.size:", interestVec.size);
console.log("orchestrated.candidates.length:", orchestrated.candidates.length);

const stockMultiplier = (c) => (Number.isFinite(c.stockPenalty) ? c.stockPenalty : 1.0);
const ranked = personalizedRank(
  orchestrated.candidates,
  behaviorScoresMap,
  interestVec,
  candidateMetaMap,
  stockMultiplier,
);

console.log("---APPLE PHONES IN RANKED LIST (sorted by personalizedRank)---");
ranked.forEach((c, i) => {
  if (appleIds.has(c.id)) {
    console.log(
      `rank=${i + 1} finalScore=${c.finalScore?.toFixed(4)} baseScore=${c.baseScore?.toFixed(4)} stMatch=${c.shortTermMatch?.toFixed(4)} sources=${JSON.stringify(c.retrievalSources)} ms=${c.matchScoreFastApi} | ${c.brand?.name} ${c.modelName}`,
    );
  }
});
console.log("TOTAL_RANKED:", ranked.length);

console.log("---TOP_25 RANKED---");
ranked.slice(0, 25).forEach((c, i) => {
  const mark = appleIds.has(c.id) ? "★APPLE" : "      ";
  console.log(
    `${(i + 1).toString().padStart(3)}. ${mark} fs=${c.finalScore?.toFixed(4)} bs=${c.baseScore?.toFixed(4)} src=${JSON.stringify(c.retrievalSources)} | ${c.brand?.name} ${c.modelName}`,
  );
});

console.log("---EAGER_SLICE_0_60_APPLES---");
const EAGER_TOP_N = 60;
const eagerSlice = ranked.slice(0, EAGER_TOP_N);
const appleInEager = eagerSlice.filter((c) => appleIds.has(c.id));
console.log("appleInEager:", appleInEager.length, "of", eagerSlice.length);
for (const c of appleInEager) {
  console.log(
    `  ${c.brand?.name} ${c.modelName} (rank=${ranked.indexOf(c) + 1}, fs=${c.finalScore?.toFixed(4)})`,
  );
}

console.log("---LAZY_61_180_APPLES---");
const lazy = ranked.slice(EAGER_TOP_N);
const appleInLazy = lazy.filter((c) => appleIds.has(c.id));
console.log("appleInLazy:", appleInLazy.length, "of", lazy.length);
for (const c of appleInLazy) {
  console.log(
    `  ${c.brand?.name} ${c.modelName} (rank=${ranked.indexOf(c) + 1}, fs=${c.finalScore?.toFixed(4)})`,
  );
}

process.exit(0);
