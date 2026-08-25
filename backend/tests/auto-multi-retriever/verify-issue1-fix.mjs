// Live verification of Issue 1 fix for user 9cb61ede-245c-4ac4-8b2d-c7c24020a5b1.
//
// Before fix: every AUTO request failed with
//   "event":"persona_unavailable" "error":"Python /recommend failed:
//   \"Custom persona needs custom_weights_stars\""
// and served only the behavioural fallback (totalCandidates ~77).
//
// Expected after fix:
// - No "event":"persona_unavailable" log line for this user.
// - family=persona shows real overfetched/survivedFilter numbers (not null).
// - totalCandidates is back to ~180, retrievalSources includes "persona".

import "dotenv/config";

console.log("[verify-issue1-fix] ML_BASE_URL =", process.env.ML_BASE_URL);

const TEST_USER = "9cb61ede-245c-4ac4-8b2d-c7c24020a5b1";

process.env.AUTO_MULTI_RETRIEVER_ENABLED = "true";
process.env.AUTO_MULTI_RETRIEVER_ROLLOUT_PCT = "100";

const captured = [];
const origInfo = console.info;
const origErr = console.error;
console.info = (...args) => {
  const line = args.join(" ");
  captured.push(line);
  origInfo(...args);
};
console.error = (...args) => {
  const line = args.join(" ");
  captured.push(line);
  origErr(...args);
};

const { orchestrate } = await import("../../src/services/autoMultiRetriever.mjs");
const { prisma } = await import("../../src/config/prisma.mjs");

const result = await orchestrate(TEST_USER, {
  persona: "allrounder", // simulate the Level B defense substitution
  budget: { min: 0, max: 1500 },
  requestId: "verify-issue1-fix",
});

console.info = origInfo;
console.error = origErr;

console.log("\n========= VERIFY ISSUE 1 FIX =========");
console.log("Total candidates:    ", result.candidates.length);
console.log("retrievalSources:    ", JSON.stringify(result.retrievalSources));
console.log("personaFailed:       ", result.metrics?.personaFailed);
console.log("behavioralFallbackServed:", result.metrics?.behavioralFallbackServed);
console.log("\n--- relevant auto_retrieval log lines ---");
for (const line of captured) {
  if (
    line.includes('"namespace":"auto_retrieval"') &&
    (line.includes('"family":"persona"') ||
      line.includes('"family":"affinity"') ||
      line.includes('"family":"brand"') ||
      line.includes('"family":"model"') ||
      line.includes('"family":"tier"') ||
      line.includes('"event":"persona_unavailable"') ||
      line.includes('"totalCandidates"'))
  ) {
    console.log(line);
  }
}
console.log("--- end log lines ---\n");

// Verdict
const personaLine = captured.find(
  (l) =>
    l.includes('"namespace":"auto_retrieval"') &&
    l.includes('"family":"persona"'),
);
const hasUnavailable = captured.some((l) =>
  l.includes('"event":"persona_unavailable"'),
);
const totalLine = captured.find((l) => l.includes('"totalCandidates"'));

console.log("VERDICT:");
console.log("  persona_unavailable event emitted:", hasUnavailable, hasUnavailable ? "❌ FAIL" : "✅ PASS");
console.log("  family=persona log line present:  ", Boolean(personaLine), personaLine ? "✅ PASS" : "❌ FAIL");
console.log("  totalCandidates line present:     ", Boolean(totalLine), totalLine ? "✅" : "❌");
console.log("  totalCandidates === 180:          ", result.candidates.length === 180, result.candidates.length === 180 ? "✅" : "❌");
console.log("  retrievalSources includes persona:", (result.retrievalSources || []).includes("persona"), (result.retrievalSources || []).includes("persona") ? "✅" : "❌");

await prisma.$disconnect();
process.exit(0);
