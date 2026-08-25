// Test B — high-affinity phone with a hard-filter violation is dropped.
//
// Setup:
//   - User `userB` has BehaviorScore:
//     tag = "affinity:<phoneB-id>", score = 9.0 (very high)
//   - phoneB is seeded with RAM = 2GB → fails the AUTO hard filter
//     floor of RAM_ABSOLUTE_FLOOR_GB = 4 (matches Python recommend.py:134
//     and `applyHardFilters` in autoMultiRetriever.mjs).
//
// Assertion:
//   - orchestrate(userB) final candidate list must NOT contain phoneB.

import "dotenv/config";
import {
  startMockPersonaServer,
  assert,
} from "./harness.mjs";
import { TEST_IDS } from "./test-ids.mjs";

const mock = await startMockPersonaServer([]);
process.env.ML_BASE_URL = mock.url;
process.env.AUTO_MULTI_RETRIEVER_ENABLED = "true";
process.env.AUTO_MULTI_RETRIEVER_ROLLOUT_PCT = "100";

const { orchestrate } = await import("../../src/services/autoMultiRetriever.mjs");
const { prisma } = await import("../../src/config/prisma.mjs");

// Sanity-check the seeded phone's RAM from the DB so the test
// report shows the actual data we exercised against.
const phoneBRow = await prisma.phones.findUnique({
  where: { phoneId: TEST_IDS.phoneB },
  include: { variants: { orderBy: { price: "asc" }, take: 1 } },
});

const result = await orchestrate(TEST_IDS.userB, {
  persona: "allrounder",
  budget: { min: 0, max: 1500 },
  requestId: "test-b",
});

const candidateIds = (result.candidates || []).map((c) => c.id).filter(Boolean);
const phoneBIncluded = candidateIds.includes(TEST_IDS.phoneB);
const affinityMetrics = result.metrics?.perFamily?.affinity || {};

console.log("\n========= TEST B RESULTS =========");
console.log("phoneB variants[0].ramGb:    ", phoneBRow?.variants?.[0]?.ramGb);
console.log("phoneB price:                ", phoneBRow?.variants?.[0]?.price);
console.log("phoneB in_stock:             ", phoneBRow?.stockState);
console.log("Affinity overfetched:        ", affinityMetrics.overfetched);
console.log("Affinity survivedFilter:     ", affinityMetrics.survivedFilter);
console.log("Total candidates returned:   ", candidateIds.length);
console.log("Test phoneB (RAM=2) in pool: ", phoneBIncluded);
console.log("=================================");

let pass = true;
const failures = [];
try {
  assert(
    (phoneBRow?.variants?.[0]?.ramGb ?? 0) < 4,
    `phoneB seeded with RAM below floor (got ${phoneBRow?.variants?.[0]?.ramGb})`,
  );
} catch (e) { pass = false; failures.push(e.message); }

try {
  assert(!phoneBIncluded, "phoneB should NOT be in candidate set (hard filter)");
} catch (e) { pass = false; failures.push(e.message); }

if (!pass) {
  console.error("FAIL:", failures.join("; "));
  process.exitCode = 1;
} else {
  console.log("PASS: phoneB excluded by RAM hard filter despite strong affinity score");
}
await mock.close();
await prisma.$disconnect();
