// Test E — persona failure fallback.
//
// Setup: live orchestrator with the persona mock server returning
// 500 to simulate Python being unavailable. Affinity: row points at
// phoneA (eligible).
//
// Assertion:
//   - behaviorSourceServed flag is set when persona fails AND behavioral
//     pool >= AUTO_MIN_FALLBACK_POOL (30). With our fixture we only
//     have 1 affinity candidate, so the pool is below the floor —
//     assert behavioralFallbackServed === false and final pool still
//     returns the 1 best eligible phone.
//   - logPersonaUnavailable is invoked (we capture log lines and grep
//     for "event":"persona_unavailable").
//
// Behavioral contract per design doc Step 7A: "never cold-start the
// user in this case" — even below the fallback floor, return best
// eligible (which is what `workingPool = behavioralCandidates.slice()`
// already does when persona fails). The orchestrator does NOT trigger
// any cold-start fallback.

import "dotenv/config";
import http from "node:http";
import {
  assert,
} from "./harness.mjs";
import { TEST_IDS } from "./test-ids.mjs";

// Mock persona that always returns 500.
const mock = await new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "persona service unavailable" }));
    });
  });
  server.listen(0, "127.0.0.1", () => {
    resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(() => r())),
    });
  });
});

// Capture log lines for assertion.
const captured = [];
const origInfo = console.info;
const origError = console.error;
console.info = (...args) => {
  captured.push(args.join(" "));
  origInfo(...args);
};
console.error = (...args) => {
  captured.push(args.join(" "));
  origError(...args);
};

process.env.ML_BASE_URL = mock.url;
process.env.AUTO_MULTI_RETRIEVER_ENABLED = "true";
process.env.AUTO_MULTI_RETRIEVER_ROLLOUT_PCT = "100";
process.env.AUTO_MIN_FALLBACK_POOL = "30";

const { orchestrate } = await import("../../src/services/autoMultiRetriever.mjs");
const { prisma } = await import("../../src/config/prisma.mjs");

const result = await orchestrate(TEST_IDS.userA, {
  persona: "allrounder",
  budget: { min: 0, max: 1500 },
  requestId: "test-e",
});

const ids = result.candidates.map((c) => c.id);
const personaUnavailableLog = captured.some(
  (l) => l.includes('"event":"persona_unavailable"') || l.includes('"event": "persona_unavailable"'),
);

// Restore console.
console.info = origInfo;
console.error = origError;

console.log("\n========= TEST E RESULTS =========");
console.log("personaFailed:               ", result.metrics?.personaFailed);
console.log("behavioralFallbackServed:    ", result.metrics?.behavioralFallbackServed);
console.log("Candidate IDs:               ", ids);
console.log("Log line 'persona_unavailable' emitted? ", personaUnavailableLog);
console.log("=================================");

let pass = true;
const failures = [];
try {
  assert(result.metrics?.personaFailed === true, "persona should be marked failed");
} catch (e) { pass = false; failures.push(e.message); }

try {
  assert(
    result.metrics?.behavioralFallbackServed === false,
    "below AUTO_MIN_FALLBACK_POOL (30) so behavioralFallbackServed should be false",
  );
} catch (e) { pass = false; failures.push(e.message); }

try {
  assert(personaUnavailableLog, "logPersonaUnavailable should have been invoked");
} catch (e) { pass = false; failures.push(e.message); }

// The orchestrator's Step 7A says: below the floor, return best
// eligible (already-filtered). We don't trigger cold-start. With our
// 1-affinity-candidate fixture, that 1 candidate IS the best eligible
// and should be returned.
try {
  assert(ids.includes(TEST_IDS.phoneA),
    "phoneA should still be returned as the best eligible below floor");
} catch (e) { pass = false; failures.push(e.message); }

if (!pass) {
  console.error("FAIL:", failures.join("; "));
  process.exitCode = 1;
} else {
  console.log("PASS: persona-unavailable fallback works (no cold-start, best eligible returned)");
}
await mock.close();
await prisma.$disconnect();
