// Re-run persona verification for user 58c4a2e5-28e4-4be0-a294-c14198f5417b
// against the REAL ML_BASE_URL (no mock). The earlier
// verify-overfetch-cap.mjs script DID set ML_BASE_URL to a localhost
// mock — that explains the 0/50 numbers. This script:
//   1. Does NOT spawn a mock server
//   2. Does NOT overwrite process.env.ML_BASE_URL
//   3. Imports dotenv/config first so .env wins
//   4. Captures the persona log line and prints it
//
// Goal: confirm the persona call returns 180/180 against the real
// ML_BASE_URL, matching the earlier baseline.

import "dotenv/config";

// Diagnostic: confirm ML_BASE_URL before any other import.
console.log("[verify-persona-live] ML_BASE_URL =", process.env.ML_BASE_URL);

const TEST_USER = "58c4a2e5-28e4-4be0-a294-c14198f5417b";

process.env.AUTO_MULTI_RETRIEVER_ENABLED = "true";
process.env.AUTO_MULTI_RETRIEVER_ROLLOUT_PCT = "100";

// Capture auto_retrieval log lines.
const captured = [];
const origInfo = console.info;
console.info = (...args) => {
  const line = args.join(" ");
  captured.push(line);
  origInfo(...args);
};

const { orchestrate } = await import("../../src/services/autoMultiRetriever.mjs");
const { prisma } = await import("../../src/config/prisma.mjs");

const t0 = Date.now();
const result = await orchestrate(TEST_USER, {
  persona: "allrounder",
  budget: { min: 0, max: 1500 },
  requestId: "verify-persona-live",
});
const elapsed = Date.now() - t0;

console.info = origInfo;

console.log("\n========= VERIFY PERSONA LIVE =========");
console.log("Total candidates: ", result.candidates.length);
console.log("Elapsed (ms):     ", elapsed);
console.log("Persona failed?:  ", result.metrics?.personaFailed);
console.log("\n--- auto_retrieval log lines ---");
for (const line of captured) {
  if (line.includes('"namespace": "auto_retrieval"')) {
    console.log(line);
  }
}
console.log("--- end log lines ---\n");

await prisma.$disconnect();
process.exit(0);
