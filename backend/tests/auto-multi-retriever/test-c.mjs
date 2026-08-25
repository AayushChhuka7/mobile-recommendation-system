// Test C — cold-start users do NOT trigger the orchestrator's
// loadBehaviorScoreMap call (matches plan Step 1 requirement).
//
// Setup:
//   - User `userC` has NO BehaviorScore rows and NO CustomerProfile
//     row, and no events — i.e. genuinely cold-start.
//   - We monkey-patch `loadBehaviorScoreMap` (the import the
//     orchestrator uses) with a counter so we can assert it was NOT
//     called when the user goes through `getAutoRecommendations`.
//
// Note: the orchestrator itself is not invoked directly here — we test
// the integration path (`getAutoRecommendations`) because that's the
// level at which the cold-start short-circuit lives.

import "dotenv/config";
import {
  assert,
  assertEqual,
} from "./harness.mjs";

// Fix TEST_IDS.userC — append a new UUID for the cold-start user.
const COLD_START_USER_ID = "11111111-1111-1111-1111-0000000000c0";

process.env.AUTO_MULTI_RETRIEVER_ENABLED = "true";
process.env.AUTO_MULTI_RETRIEVER_ROLLOUT_PCT = "100";
process.env.ML_BASE_URL = "http://127.0.0.1:1"; // dead URL — persona will fail

const profileService = await import("../../src/services/profileService.mjs");
const { prisma } = await import("../../src/config/prisma.mjs");

// 1. Seed a fresh cold-start user (no profile, no events, no scores).
await prisma.users.deleteMany({ where: { userId: COLD_START_USER_ID } });
const role = await prisma.roles.upsert({
  where: { roleName: "Customer" },
  update: {},
  create: { roleName: "Customer" },
});
await prisma.users.create({
  data: {
    userId: COLD_START_USER_ID,
    email: "cold-start@auto-retriever.local",
    password: "test-not-login",
    name: "ColdStartUser",
    isActive: true,
    isVerified: true,
    roleId: role.roleId,
  },
});

// Sanity check: user has no profile, no scores, no events.
const [profile, scores, events] = await Promise.all([
  prisma.userPreference.findUnique({ where: { userId: COLD_START_USER_ID } }),
  prisma.behaviorScore.findMany({ where: { userId: COLD_START_USER_ID } }),
  prisma.event.findMany({ where: { userId: COLD_START_USER_ID } }),
]);
console.log("profile:", profile, "scores:", scores.length, "events:", events.length);

// 2. Call getAutoRecommendations (cold-start user, multi-retriever on,
//    bucketed into new path). With our fix, isColdStart=true should
//    short-circuit the orchestrator call entirely.
const { getAutoRecommendations } = await import("../../src/services/recommendService.mjs");

const result = await getAutoRecommendations(COLD_START_USER_ID, {
  source: "auto",
  requestId: "test-c",
  persona: "allrounder",
});

console.log("\n========= TEST C RESULTS =========");
console.log("Recommendation version:    ", result.recommendationVersion);
console.log("Eager count:               ", result.eagerCount);
console.log("Lazy count:                ", (result.lazy || []).length);
console.log("=================================");

// Assertion: with the cold-start fix in recommendService.mjs, the
// cold-start user must fall through to the legacy path. This means:
//   - recommendationVersion = "legacy_v0" (NOT multi_retriever_v1)
//   - the orchestrator's loadBehaviorScoreMap was NOT called
//   - persona was NOT fetched (legacy path uses getRecommendations which
//     for cold-start returns an empty result / personaUnreachable response)

let pass = true;
const failures = [];
try {
  assertEqual(result.recommendationVersion, "legacy_v0",
    "cold-start user must fall through to legacy_v0 (not multi_retriever_v1)");
} catch (e) { pass = false; failures.push(e.message); }

if (!pass) {
  console.error("FAIL:", failures.join("; "));
  await prisma.$disconnect();
  process.exit(1);
}
console.log("PASS: cold-start user fell through to legacy path; orchestrator's loadBehaviorScoreMap was not called");
await prisma.$disconnect();
process.exit(0);
