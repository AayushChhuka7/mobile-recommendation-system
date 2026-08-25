// GROUP 3 live verification — catalog resolution fix.
//
// Triggers a REAL orchestrate() call (the exact function the AUTO route
// `GET /api/recommend/auto` invokes) against the live DB for a seeded
// user that has all four behavioral families:
//   affinity: + brand: + model: + tier:
//
// Phones carry real `antutuScore` values so tier is derived on the fly
// via the shared `inferTier` (flagship ≥900k, mid ≥500k, budget <500k).
//
// A tiny in-process mock stands in for Python `/recommend` so persona
// also contributes a source. We capture the real `auto_retrieval`
// console output and assert the catalog bug is gone.
//
// This is a verification harness, NOT part of run-all.mjs. It seeds its
// own rows under a dedicated UUID range and tears them down at the end.

import "dotenv/config";
import http from "node:http";

// Distinct UUID range so we never collide with the A/B/C/D/E/F fixtures.
const V = Object.freeze({
  user:       "44444444-4444-4444-4444-000000000001",
  brand:      "44444444-4444-4444-4444-0000000000b1",
  phoneFlag:  "44444444-4444-4444-4444-0000000000f1",
  phoneMid:   "44444444-4444-4444-4444-0000000000d1",
  phoneBudget:"44444444-4444-4444-4444-0000000000c1",
});
const BRAND_NAME = "VerifyBrand";
const MODEL_FLAG = "VerifyPhone Flagship X";
const MODEL_MID = "VerifyPhone Mid Y";
const MODEL_BUDGET = "VerifyPhone Budget Z";

// Mock Python persona server. Returns the BUDGET phone so persona is a
// distinct contributing source alongside the behavioral families.
const mock = await new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/recommend") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            results: [
              {
                Brand: BRAND_NAME,
                Model: MODEL_BUDGET,
                Match_Score: 0.71,
                Overall_Score: 0.66,
                Value_Score: 0.6,
              },
            ],
          }),
        );
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
  });
  server.listen(0, "127.0.0.1", () => {
    resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(() => r())),
    });
  });
});

// Must set ML_BASE_URL BEFORE importing the orchestrator (config/ml.mjs
// binds it at import time — same ordering test-e.mjs relies on).
process.env.ML_BASE_URL = mock.url;
process.env.AUTO_MULTI_RETRIEVER_ENABLED = "true";
process.env.AUTO_MULTI_RETRIEVER_ROLLOUT_PCT = "100";

const { orchestrate } = await import("../../src/services/autoMultiRetriever.mjs");
const { hashModelName, inferTier } = await import("../../src/services/behaviorAnalyzer.mjs");
const { prisma } = await import("../../src/config/prisma.mjs");

// ---- Seed --------------------------------------------------------------
async function clean() {
  await prisma.behaviorScore.deleteMany({ where: { userId: V.user } });
  await prisma.phoneSpecs.deleteMany({
    where: { phoneId: { in: [V.phoneFlag, V.phoneMid, V.phoneBudget] } },
  });
  await prisma.phoneVariants.deleteMany({
    where: { phoneId: { in: [V.phoneFlag, V.phoneMid, V.phoneBudget] } },
  });
  await prisma.phones.deleteMany({
    where: { phoneId: { in: [V.phoneFlag, V.phoneMid, V.phoneBudget] } },
  });
  await prisma.users.deleteMany({ where: { userId: V.user } });
  await prisma.brands.deleteMany({ where: { brandId: V.brand } });
}

async function seed() {
  await clean();

  const role = await prisma.roles.upsert({
    where: { roleName: "Customer" },
    update: {},
    create: { roleName: "Customer" },
  });
  await prisma.users.create({
    data: {
      userId: V.user,
      email: "verify-catalog-fix@auto-retriever.local",
      password: "test-not-login",
      name: "VerifyCatalogUser",
      isActive: true,
      isVerified: true,
      roleId: role.roleId,
    },
  });
  await prisma.brands.create({ data: { brandId: V.brand, name: BRAND_NAME } });

  // antutuScore drives tier: flagship ≥900k, mid ≥500k, budget <500k.
  const phones = [
    { id: V.phoneFlag,   model: MODEL_FLAG,   antutu: 950000 },
    { id: V.phoneMid,    model: MODEL_MID,    antutu: 600000 },
    { id: V.phoneBudget, model: MODEL_BUDGET, antutu: 300000 },
  ];
  for (const p of phones) {
    await prisma.phones.create({
      data: {
        phoneId: p.id,
        brandId: V.brand,
        modelName: p.model,
        antutuScore: p.antutu,
        stockState: "in_stock",
        releasedAt: new Date("2026-01-01"),
        isActive: true,
      },
    });
    await prisma.phoneVariants.create({
      data: {
        phoneId: p.id,
        ramGb: 8, // passes RAM ≥ 4 hard filter
        storageGb: 128,
        price: "499.00",
        isAvailable: true,
      },
    });
    await prisma.phoneSpecs.create({
      data: {
        phoneId: p.id,
        supports5g: true,
        supportsNfc: true,
        dualSim: true,
        batteryMah: 5000,
      },
    });
  }

  // One BehaviorScore row per family so activeCount = 4 (this is what
  // makes the catalog query run — the query that used to fail).
  const modelHashFlag = hashModelName(MODEL_FLAG);
  const rows = [
    { tag: `affinity:${V.phoneFlag}`, score: 8.5 }, // → flagship
    { tag: "brand:verifybrand",       score: 7.0 }, // → all 3 phones
    { tag: `model:${modelHashFlag}`,  score: 6.5 }, // → flagship
    { tag: "tier:flagship",           score: 6.0 }, // → flagship
    { tag: "tier:mid",                score: 5.5 }, // → mid
  ];
  for (const r of rows) {
    await prisma.behaviorScore.create({
      data: { userId: V.user, tag: r.tag, score: r.score },
    });
  }

  // Sanity: confirm tier derivation matches what we expect.
  console.log("[verify] tier(flagship phone) =", inferTier({ antutuScore: 950000 }));
  console.log("[verify] tier(mid phone)      =", inferTier({ antutuScore: 600000 }));
  console.log("[verify] tier(budget phone)   =", inferTier({ antutuScore: 300000 }));
  console.log("[verify] model hash (flagship)=", modelHashFlag);
}

// ---- Capture the real auto_retrieval log lines -------------------------
const captured = [];
const origInfo = console.info;
const origError = console.error;
console.info = (...a) => { captured.push(a.join(" ")); origInfo(...a); };
console.error = (...a) => { captured.push(a.join(" ")); origError(...a); };

await seed();

const result = await orchestrate(V.user, {
  persona: "allrounder",
  budget: { min: 0, max: 1500 },
  requestId: "verify-catalog-fix",
});

console.info = origInfo;
console.error = origError;

// ---- Report ------------------------------------------------------------
const autoLines = captured
  .map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  })
  .filter((o) => o && o.namespace === "auto_retrieval");

console.log("\n=========== RAW auto_retrieval LOG LINES ===========");
for (const o of autoLines) console.log(JSON.stringify(o));
console.log("====================================================\n");

const familyFailedCatalog = autoLines.filter(
  (o) => o.event === "family_failed" && o.family === "catalog",
);
const perFamily = {};
for (const o of autoLines) {
  if (o.family && o.event === undefined) perFamily[o.family] = o;
}
const summary = autoLines.find((o) => o.totalCandidates !== undefined);

console.log("========= GROUP 3 VERIFICATION RESULTS =========");
console.log("family_failed(catalog) count:", familyFailedCatalog.length);
for (const fam of ["affinity", "brand", "model", "tier", "persona"]) {
  const row = perFamily[fam];
  console.log(
    `  family=${fam.padEnd(8)} survivedDedup=`,
    row ? row.survivedDedup : "(no line)",
  );
}
console.log("retrievalSources:", summary ? summary.retrievalSources : "(no summary)");
console.log("totalCandidates :", summary ? summary.totalCandidates : "(no summary)");
console.log("================================================\n");

let pass = true;
const fail = [];
const check = (cond, msg) => { if (!cond) { pass = false; fail.push(msg); } };

check(familyFailedCatalog.length === 0, "catalog must NOT emit family_failed");
check((perFamily.brand?.survivedDedup ?? 0) > 0, "brand survivedDedup must be > 0");
check((perFamily.model?.survivedDedup ?? 0) > 0, "model survivedDedup must be > 0");
check((perFamily.tier?.survivedDedup ?? 0) > 0, "tier survivedDedup must be > 0");
const srcs = summary?.retrievalSources || [];
check(srcs.includes("brand"), "retrievalSources must include brand");
check(srcs.includes("model"), "retrievalSources must include model");
check(srcs.includes("tier"), "retrievalSources must include tier");

if (pass) {
  console.log("PASS: catalog resolves; brand/model/tier all contribute; no family_failed(catalog).");
} else {
  console.error("FAIL:", fail.join("; "));
  process.exitCode = 1;
}

await clean();
await mock.close();
await prisma.$disconnect();
