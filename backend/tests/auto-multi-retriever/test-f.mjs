// Test F — two active families split the full allocation.
//
// Setup:
//   - User `userF` has BehaviorScore rows ONLY under `affinity:` and
//     `brand:` prefixes (no `model:` or `tier:` rows).
//   - Active families should be exactly 2 (affinity + brand).
//   - AUTO_BEHAVIOR_TARGET = 180 - round(180 * 0.28) = 180 - 50 = 130.
//   - Expected: each active family gets floor(130 / 2) = 65.
//
// This is a unit-level test of the family-allocation math; we don't
// need a full orchestrate() call (which would also fan out to catalog
// + persona). The math lives in:
//   autoMultiRetriever.mjs:500-502  (perFamilyAllocation)
//   autoMultiRetriever.mjs:128-130  (partition sort + activeCount)
//   autoRetrieval.mjs:58-65        (AUTO_PERSONA_TARGET / AUTO_BEHAVIOR_TARGET)

import "dotenv/config";
import {
  assert,
  assertEqual,
} from "./harness.mjs";
import { TEST_IDS } from "./test-ids.mjs";

process.env.AUTO_MULTI_RETRIEVER_ENABLED = "true";
process.env.AUTO_MULTI_RETRIEVER_ROLLOUT_PCT = "100";
process.env.AUTO_FINAL_POOL_TARGET = "180";
process.env.AUTO_PERSONA_SHARE = "0.28";

const {
  partitionBehaviorScoresByFamily,
} = await import("../../src/services/autoMultiRetriever.mjs");
const {
  AUTO_FINAL_POOL_TARGET,
  AUTO_PERSONA_TARGET,
  AUTO_BEHAVIOR_TARGET,
} = await import("../../src/config/autoRetrieval.mjs");
const { loadBehaviorScoreMap } = await import("../../src/services/profileService.mjs");
const { prisma } = await import("../../src/config/prisma.mjs");

// 1. Pull userF's actual scores from the DB (truth, not seed in-memory copy).
const behaviorScoresMap = await loadBehaviorScoreMap(TEST_IDS.userF);
const { families, activeCount } =
  partitionBehaviorScoresByFamily(behaviorScoresMap);

const perFamilyAllocation =
  activeCount > 0 ? Math.floor(AUTO_BEHAVIOR_TARGET / activeCount) : 0;

console.log("\n========= TEST F RESULTS =========");
console.log("AUTO_FINAL_POOL_TARGET:    ", AUTO_FINAL_POOL_TARGET);
console.log("AUTO_PERSONA_TARGET:       ", AUTO_PERSONA_TARGET);
console.log("AUTO_BEHAVIOR_TARGET:      ", AUTO_BEHAVIOR_TARGET);
console.log("BehaviorScoresMap size:    ", behaviorScoresMap ? behaviorScoresMap.size : 0);
console.log("Affinity rows:             ", families.affinity.length, families.affinity.map((r) => r.tag));
console.log("Brand rows:                ", families.brand.length, families.brand.map((r) => r.tag));
console.log("Model rows:                ", families.model.length);
console.log("Tier rows:                 ", families.tier.length);
console.log("activeCount:               ", activeCount);
console.log("perFamilyAllocation:       ", perFamilyAllocation);
console.log("==================================");

let pass = true;
const failures = [];
try {
  assert(behaviorScoresMap != null, "userF should have a behavior-score map");
  assertEqual(families.affinity.length, 1, "exactly 1 affinity row");
  assertEqual(families.brand.length, 2, "exactly 2 brand rows");
  assertEqual(families.model.length, 0, "zero model rows");
  assertEqual(families.tier.length, 0, "zero tier rows");
  assertEqual(activeCount, 2, "exactly 2 active families");
  assertEqual(AUTO_BEHAVIOR_TARGET, 130, "behavior target = 130 with default share");
  assertEqual(perFamilyAllocation, 65, "each family should get 65, not 26");
} catch (e) { pass = false; failures.push(e.message); }

if (!pass) {
  console.error("FAIL:", failures.join("; "));
  process.exitCode = 1;
} else {
  console.log("PASS: 2 active families split 130/2 = 65 each (not 130/5 = 26)");
}
await prisma.$disconnect();
