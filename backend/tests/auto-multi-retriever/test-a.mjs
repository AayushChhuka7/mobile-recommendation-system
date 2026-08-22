// Test A — high-affinity phone surfaces despite low persona rank.
//
// Setup:
//   - User `userA` has a single BehaviorScore row:
//     tag = "affinity:<phoneA-id>", score = 8.5
//   - The seeded phoneA passes all hard filters (RAM 8GB, in_stock).
//   - Python /recommend is mocked to return a Top-50 list of OTHER
//     phones (no phoneA).
//
// Assertion:
//   - Run orchestrate(userA, { persona: "allrounder", ... }).
//   - Final candidate list must contain phoneA.
//
// Mock decision: explicitly mocked. The persona retrieval path requires
// a live Python ML service which is not available in this sandbox. The
// orchestrator's behaviorScore + family partitioning logic is the
// regression target — Python is incidental. Mocking it isolates the
// test to what we care about: that affinity rows can pull a phone into
// the pool even when Python would have excluded it.

import "dotenv/config";
import http from "node:http";
import {
  startMockPersonaServer,
  assert,
} from "./harness.mjs";
import { TEST_IDS } from "./test-ids.mjs";

// 1. Start mock Python server BEFORE importing the orchestrator so the
//    env var is in scope when ML_BASE_URL is read.
const otherPhone = {
  brand: "TestBrandA",
  modelName: "OTHER_PHONE_NOT_TARGET",
  Match_Score: 0.95,
  Overall_Score: 0.9,
  Value_Score: 0.9,
};
const personaResult = {
  results: Array.from({ length: 50 }, (_, i) => ({
    ...otherPhone,
    modelName: `OTHER_PHONE_${String(i).padStart(3, "0")}`,
  })),
};
const mock = await startMockPersonaServer(personaResult.results);
process.env.ML_BASE_URL = mock.url;
// Force the AUTO flags to the values the orchestrator will read at call time.
process.env.AUTO_MULTI_RETRIEVER_ENABLED = "true";
process.env.AUTO_MULTI_RETRIEVER_ROLLOUT_PCT = "100";
process.env.AUTO_FINAL_POOL_TARGET = "180";
process.env.AUTO_PERSONA_SHARE = "0.28";

// 2. Import AFTER env is set.
const { orchestrate } = await import("../../src/services/autoMultiRetriever.mjs");
const { prisma } = await import("../../src/config/prisma.mjs");

// 3. Force bucket into new path (the orchestrator is called directly,
//    so bucketUserForRollout is not invoked — we just call orchestrate).
const result = await orchestrate(TEST_IDS.userA, {
  persona: "allrounder",
  budget: { min: 0, max: 1500 },
  requestId: "test-a",
});

const candidateIds = (result.candidates || []).map((c) => c.id).filter(Boolean);
const phoneAIncluded = candidateIds.includes(TEST_IDS.phoneA);
const personaFailed = result.metrics?.personaFailed === true;

console.log("\n========= TEST A RESULTS =========");
console.log("Mock Python URL:                  ", mock.url);
console.log("Persona returned 50 items?        ", !personaFailed);
console.log("Total candidates returned:        ", candidateIds.length);
console.log("Test phoneA (affinity target) in: ", phoneAIncluded);
console.log("Total source families used:       ", result.retrievalSources);
console.log("Metrics:                          ", JSON.stringify(result.metrics?.perFamily, null, 2));
console.log("==================================");

let pass = true;
const failures = [];
try {
  assert(!personaFailed, "persona fetch should have succeeded against mock");
} catch (e) { pass = false; failures.push(e.message); }

try {
  assert(phoneAIncluded, `phoneA (${TEST_IDS.phoneA}) should be in candidate set`);
} catch (e) { pass = false; failures.push(e.message); }

if (!pass) {
  console.error("FAIL:", failures.join("; "));
  process.exitCode = 1;
} else {
  console.log("PASS: phoneA surfaced via affinity retrieval despite persona Top-50 excluding it");
}
await mock.close();
await prisma.$disconnect();
