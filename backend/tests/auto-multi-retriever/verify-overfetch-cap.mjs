// Verify the brand/tier over-fetch cap with a live orchestrator run.
// User has brand:vivo (585 phones in DB) + tier:flagship (huge bucket).
// Capture auto_retrieval log lines and assert the overfetched numbers.

import "dotenv/config";
import http from "node:http";

const TEST_USER = "58c4a2e5-28e4-4be0-a294-c14198f5417b";

// 1. Mock persona server (canned but minimal).
const personaResult = Array.from({ length: 50 }, (_, i) => ({
  brand: "TestBrandA",
  modelName: `PERSONA_PHONE_${String(i).padStart(3, "0")}`,
  Match_Score: 0.95,
  Overall_Score: 0.9,
  Value_Score: 0.9,
}));
const mock = await new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: personaResult }));
    });
  });
  const openSockets = new Set();
  server.on("connection", (s) => {
    openSockets.add(s);
    s.on("close", () => openSockets.delete(s));
  });
  server.listen(0, "127.0.0.1", () => {
    resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () =>
        new Promise((r) => {
          for (const s of openSockets) { try { s.destroy(); } catch (_) {} }
          server.close(() => r());
        }),
    });
  });
});

process.env.ML_BASE_URL = mock.url;
process.env.AUTO_MULTI_RETRIEVER_ENABLED = "true";
process.env.AUTO_MULTI_RETRIEVER_ROLLOUT_PCT = "100";

// 2. Capture log lines.
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
  requestId: "verify-overfetch-cap",
});
const elapsed = Date.now() - t0;

console.info = origInfo;

// 3. Surface log lines + metrics.
console.log("\n========= VERIFY OVERFETCH CAP =========");
console.log("Total candidates:", result.candidates.length);
console.log("Elapsed (ms):    ", elapsed);
console.log("Per-family state:");
console.log(JSON.stringify(result.metrics?.perFamily, null, 2));
console.log("\n--- auto_retrieval log lines ---");
for (const line of captured) {
  if (line.includes('"namespace": "auto_retrieval"')) {
    console.log(line);
  }
}
console.log("--- end log lines ---\n");

// 4. Assertions.
const lines = captured.filter((l) => l.includes('"namespace": "auto_retrieval"'));
const findLine = (family) => lines.find((l) => l.includes(`"family": "${family}"`));
const parseCount = (line, key) => {
  const m = line.match(new RegExp(`"${key}":\\s*(-?\\d+)`));
  return m ? parseInt(m[1], 10) : null;
};

const brandLine = findLine("brand");
const tierLine  = findLine("tier");
const affLine   = findLine("affinity");
const summaryLine = lines.find((l) => l.includes('"totalCandidates"'));

const brandRequested = parseCount(brandLine, "requested");
const brandOverfetched = parseCount(brandLine, "overfetched");
const tierRequested = parseCount(tierLine, "requested");
const tierOverfetched = parseCount(tierLine, "overfetched");
const affRequested = parseCount(affLine, "requested");
const affOverfetched = parseCount(affLine, "overfetched");

let pass = true;
const fails = [];
const check = (cond, msg) => { if (!cond) { pass = false; fails.push(msg); } };

// brand should be bounded by its requested value (96 by default), never exceeds AUTO_OVERFETCH_MAX (500).
check(brandOverfetched <= brandRequested, `brand overfetched (${brandOverfetched}) <= requested (${brandRequested})`);
check(brandOverfetched <= 500, `brand overfetched (${brandOverfetched}) <= AUTO_OVERFETCH_MAX (500)`);
// Same for tier.
check(tierOverfetched <= tierRequested, `tier overfetched (${tierOverfetched}) <= requested (${tierRequested})`);
check(tierOverfetched <= 500, `tier overfetched (${tierOverfetched}) <= AUTO_OVERFETCH_MAX (500)`);
// Sanity: affinity stays naturally small.
check(affOverfetched <= affRequested, `affinity overfetched (${affOverfetched}) <= requested (${affRequested})`);
// Final summary must remain ~180.
const totalCandidates = parseCount(summaryLine, "totalCandidates");
check(totalCandidates <= 180, `totalCandidates (${totalCandidates}) <= 180`);

console.log("Summary line parsed totalCandidates =", totalCandidates);
console.log("========================================");

if (!pass) {
  console.error("FAIL:", fails.join("; "));
  await mock.close();
  await prisma.$disconnect();
  process.exit(1);
}
console.log("PASS: brand & tier over-fetch cap is correctly enforced.");
await mock.close();
await prisma.$disconnect();
