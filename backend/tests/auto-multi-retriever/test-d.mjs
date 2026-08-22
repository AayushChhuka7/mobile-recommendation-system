// Test D — deterministic ordering.
//
// Setup: same fixture as Test A — userD has a single BehaviorScore row
// pointing to phoneA with score 8.5.
//
// Assertion: orchestrate(userD) called twice in immediate succession
// returns identical phoneId lists in identical order.

import "dotenv/config";
import {
  startMockPersonaServer,
  assert,
  assertDeepEqual,
} from "./harness.mjs";
import { TEST_IDS } from "./test-ids.mjs";

// Stable persona mock — same response both calls.
const personaResult = Array.from({ length: 50 }, (_, i) => ({
  brand: "TestBrandA",
  modelName: `OTHER_PHONE_${String(i).padStart(3, "0")}`,
  Match_Score: 0.95,
  Overall_Score: 0.9,
  Value_Score: 0.9,
}));
const mock = await startMockPersonaServer(personaResult);
process.env.ML_BASE_URL = mock.url;
process.env.AUTO_MULTI_RETRIEVER_ENABLED = "true";
process.env.AUTO_MULTI_RETRIEVER_ROLLOUT_PCT = "100";

const { orchestrate } = await import("../../src/services/autoMultiRetriever.mjs");
const { prisma } = await import("../../src/config/prisma.mjs");

const opts = {
  persona: "allrounder",
  budget: { min: 0, max: 1500 },
  requestId: "test-d",
};
const r1 = await orchestrate(TEST_IDS.userD, opts);
const r2 = await orchestrate(TEST_IDS.userD, opts);

const ids1 = r1.candidates.map((c) => c.id);
const ids2 = r2.candidates.map((c) => c.id);
const scores1 = r1.candidates.map((c) => c.matchScoreFastApi);
const scores2 = r2.candidates.map((c) => c.matchScoreFastApi);

console.log("\n========= TEST D RESULTS =========");
console.log("Run 1 candidate IDs:        ", ids1);
console.log("Run 2 candidate IDs:        ", ids2);
console.log("Run 1 matchScoreFastApi:    ", scores1);
console.log("Run 2 matchScoreFastApi:    ", scores2);
console.log("Identical?                   ", JSON.stringify(ids1) === JSON.stringify(ids2));
console.log("Lengths:                     ", ids1.length, "vs", ids2.length);
console.log("=================================");

let pass = true;
const failures = [];
try {
  assertDeepEqual(ids1, ids2, "candidate id order must be identical across calls");
} catch (e) { pass = false; failures.push(e.message); }

try {
  assertDeepEqual(scores1, scores2, "scores must also be identical");
} catch (e) { pass = false; failures.push(e.message); }

if (!pass) {
  console.error("FAIL:", failures.join("; "));
  process.exitCode = 1;
} else {
  console.log("PASS: ordering is deterministic across back-to-back calls");
}
await mock.close();
await prisma.$disconnect();
// Note: don't call process.exit() — let node drain open handles. The
// previous force-exit tripped libuv's UV_HANDLE_CLOSING assertion on
// Windows because fetch + http can leave idle keep-alive sockets.
