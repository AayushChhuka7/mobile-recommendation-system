// personalization_probe.mjs — end-to-end scoring-core verification harness.
//
// Purpose: prove, with numbers, how far a candidate's FINAL fused score can
// move as a user accumulates behaviour — WITHOUT a DB or a running FastAPI.
//
// It imports the REAL pure modules that ship in production:
//   - config/behaviorConfig.mjs        (all scoring constants)
//   - services/behaviorConfidence.mjs  (confidence ramp)
//   - services/behaviorAnalyzer.mjs    (applyDecay, diminishingMultiplier)
//   - services/phoneFeatureProfile.mjs (per-phone feature deltas)
//   - services/profileFusion.mjs       (fuseProfile, clampToStars)
//   - services/searchHistoryScore.mjs  (search_history sub-score, phoneToTags)
//   - services/fusionRanker.mjs        (fuseOne, FUSION_WEIGHTS)
//
// The ONLY things it mocks are the two signals that come from FastAPI
// (compatibility, customer_preference) and content_similarity/value — those
// are held at a fixed per-phone baseline, because in the live system
// behaviour reaches them only indirectly (Step C fused weights → FastAPI
// re-rank). Holding them fixed isolates exactly how much the JS-side
// search_history signal can move the final ranking on its own.

import { BEHAVIOR_CONFIG, eventBaseWeight, featureBaseWeight } from "./src/config/behaviorConfig.mjs";
import { computeConfidence } from "./src/services/behaviorConfidence.mjs";
import { applyDecay, diminishingMultiplier } from "./src/services/behaviorAnalyzer.mjs";
import { buildPhoneFeatureTagDeltas } from "./src/services/phoneFeatureProfile.mjs";
import { fuseProfile, clampToStars } from "./src/services/profileFusion.mjs";
import { searchHistoryScore, phoneToTags } from "./src/services/searchHistoryScore.mjs";
import { fuseOne, FUSION_WEIGHTS } from "./src/services/fusionRanker.mjs";

// ---------------------------------------------------------------------------
// Fixture phones. Specs chosen to land on realistic feature-profile tiers.
// `baseline` = the FastAPI-driven components (compatibility, customer_pref,
// content_similarity, value) that behaviour does NOT move in this harness.
// ---------------------------------------------------------------------------
const PHONES = [
  { id: "s26u",  name: "Samsung S26 Ultra",  brand: "Samsung", meta: { brandName:"Samsung", chipset:"Snapdragon 8 Gen 4", antutuScore:2100000, batteryMah:5000, refreshRate:120, displaySize:6.9, mainCameraMp:200 }, base:{ overallScore:92, matchScoreFastApi:88, contentSim:0.80, valueScore:0.55 } },
  { id: "s25u",  name: "Samsung S25 Ultra",  brand: "Samsung", meta: { brandName:"Samsung", chipset:"Snapdragon 8 Gen 3", antutuScore:1900000, batteryMah:5000, refreshRate:120, displaySize:6.8, mainCameraMp:200 }, base:{ overallScore:89, matchScoreFastApi:85, contentSim:0.78, valueScore:0.58 } },
  { id: "hm7p",  name: "Honor Magic7 Pro",   brand: "Honor",   meta: { brandName:"Honor",   chipset:"Snapdragon 8 Gen 4", antutuScore:2000000, batteryMah:5270, refreshRate:120, displaySize:6.8, mainCameraMp:50 },  base:{ overallScore:90, matchScoreFastApi:86, contentSim:0.79, valueScore:0.60 } },
  { id: "xm15p", name: "Xiaomi 15 Pro",      brand: "Xiaomi",  meta: { brandName:"Xiaomi",  chipset:"Snapdragon 8 Gen 4", antutuScore:1950000, batteryMah:5400, refreshRate:120, displaySize:6.7, mainCameraMp:50 },  base:{ overallScore:88, matchScoreFastApi:84, contentSim:0.77, valueScore:0.65 } },
  { id: "rog9",  name: "Asus ROG Phone 9",   brand: "Asus",    meta: { brandName:"Asus",    chipset:"Snapdragon 8 Gen 4", antutuScore:2200000, batteryMah:5800, refreshRate:165, displaySize:6.78, mainCameraMp:50 }, base:{ overallScore:85, matchScoreFastApi:80, contentSim:0.70, valueScore:0.50 } },
  { id: "rm10",  name: "RedMagic 10 Pro",    brand: "Nubia",   meta: { brandName:"Nubia",   chipset:"Snapdragon 8 Gen 4", antutuScore:2250000, batteryMah:7050, refreshRate:144, displaySize:6.85, mainCameraMp:50 }, base:{ overallScore:84, matchScoreFastApi:79, contentSim:0.68, valueScore:0.52 } },
  { id: "iqoo13",name: "iQOO 13",            brand: "iQOO",    meta: { brandName:"iQOO",    chipset:"Snapdragon 8 Gen 4", antutuScore:2150000, batteryMah:6150, refreshRate:144, displaySize:6.82, mainCameraMp:50 }, base:{ overallScore:83, matchScoreFastApi:78, contentSim:0.67, valueScore:0.62 } },
  { id: "pixel9",name: "Pixel 9 Pro",        brand: "Google",  meta: { brandName:"Google",  chipset:"Tensor G4", antutuScore:1100000, batteryMah:4700, refreshRate:120, displaySize:6.3, mainCameraMp:50 },   base:{ overallScore:82, matchScoreFastApi:81, contentSim:0.72, valueScore:0.55 } },
  { id: "find8", name: "Oppo Find X8",       brand: "Oppo",    meta: { brandName:"Oppo",    chipset:"Dimensity 9400", antutuScore:2050000, batteryMah:5630, refreshRate:120, displaySize:6.6, mainCameraMp:50 }, base:{ overallScore:81, matchScoreFastApi:77, contentSim:0.66, valueScore:0.60 } },
  { id: "v40",   name: "Vivo X200 Pro",      brand: "Vivo",    meta: { brandName:"Vivo",    chipset:"Dimensity 9400", antutuScore:2000000, batteryMah:6000, refreshRate:120, displaySize:6.78, mainCameraMp:200 },base:{ overallScore:80, matchScoreFastApi:76, contentSim:0.69, valueScore:0.58 } },
];

// Precompute the tags each phone exposes to searchHistoryScore (uses the
// REAL phoneToTags so we test the exact vocabulary the fix touched).
for (const p of PHONES) {
  p.tags = phoneToTags({
    brand: { name: p.meta.brandName },
    antutuScore: p.meta.antutuScore,
    specs: {
      chipset: p.meta.chipset,
      mainCamera: `${p.meta.mainCameraMp} MP`,
      batteryMah: p.meta.batteryMah,
      refreshRate: p.meta.refreshRate,
    },
  });
}

// ---------------------------------------------------------------------------
// Faithful re-implementation of recordEvent's WRITE math (no DB).
// For each event we: derive tag deltas from the real feature profile,
// scale by confidence(eventCount) and diminishing(repeat), then fold into
// the running score via the real applyDecay. This mirrors recordEvent's
// per-tag loop exactly (lines 480-end use applyDecay(prev, delta*conf*dim)).
// ---------------------------------------------------------------------------
function makeBehaviorState() {
  return { scores: new Map(), eventCount: 0, repeats: new Map() };
}

function recordEventSim(state, eventType, phone) {
  state.eventCount += 1;
  const conf = computeConfidence(state.eventCount);
  const baseWeight = eventBaseWeight(eventType);
  if (baseWeight === 0) return;

  // Non-search path: per-phone feature deltas + brand + tier.
  const tagDeltas = buildPhoneFeatureTagDeltas(phone.meta, featureBaseWeight);

  // brand + tier tags (mirrors extractTagsForEvent)
  const brand = phone.meta.brandName?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  if (brand) tagDeltas.set(`brand:${brand}`, featureBaseWeight("brand"));
  const antutu = phone.meta.antutuScore;
  const tier = antutu >= 900000 ? "flagship" : antutu >= 500000 ? "mid" : "budget";
  tagDeltas.set(`tier:${tier}`, featureBaseWeight("tier"));

  for (const [tag, dimDelta] of tagDeltas.entries()) {
    const rkey = `${eventType}::${phone.id}::${tag}`;
    const n = (state.repeats.get(rkey) || 0) + 1;
    state.repeats.set(rkey, n);
    const dim = diminishingMultiplier(n);
    // recordEvent applies: delta = dimDelta * baseWeight (already inside
    // buildPhoneFeatureTagDeltas for features; brand/tier get * baseWeight
    // in extractTagsForEvent). Then * confidence * diminishing at write.
    const effectiveDelta = dimDelta * baseWeight * conf * dim;
    const prev = state.scores.get(tag) || 0;
    state.scores.set(tag, applyDecay(prev, effectiveDelta));
  }
}

function recordSearchSim(state, query) {
  state.eventCount += 1;
  const conf = computeConfidence(state.eventCount);
  const baseWeight = eventBaseWeight("search");
  // Minimal keyword map (subset of behaviorAnalyzer.SEARCH_KEYWORDS)
  const KW = { samsung:"brand:samsung", galaxy:"brand:samsung", rog:"category:gaming", gaming:"category:gaming", camera:"category:camera", battery:"category:battery", ultra:"tier:flagship" };
  const lower = query.toLowerCase();
  const seen = new Set();
  for (const [kw, tag] of Object.entries(KW)) {
    if (lower.includes(kw) && !seen.has(tag)) {
      seen.add(tag);
      const delta = baseWeight * 0.5 * conf; // searchScale = 0.5
      const prev = state.scores.get(tag) || 0;
      state.scores.set(tag, applyDecay(prev, delta));
    }
  }
}

// ---------------------------------------------------------------------------
// Step C: collapse BehaviorScore map onto the 4-dim fused weight vector.
// Replicates loadBehaviorScores + fuseProfile (behaviour-only path returns
// the clamped behaviour dims directly).
// ---------------------------------------------------------------------------
const DIM_ALIASES = {
  "feature:gaming":"gaming", "feature:camera":"camera", "feature:battery":"battery",
  "feature:performance":"gaming", "feature:display":"display",
  "category:gaming":"gaming", "category:camera":"camera", "category:battery":"battery",
};
function buildFusedWeightsSim(scores) {
  const bucket = {};
  for (const [tag, score] of scores.entries()) {
    const dim = DIM_ALIASES[tag];
    if (!dim) continue;
    bucket[dim] = (bucket[dim] || 0) + score;
  }
  const out = {};
  for (const dim of ["gaming","camera","battery","display"]) {
    if (bucket[dim] !== undefined) out[dim] = clampToStars(bucket[dim]);
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// Rank all phones through the REAL fuseOne. behaviour only reaches
// search_history here (compatibility/customer_pref/content/value are fixed
// baselines). Returns sorted list with components.
// ---------------------------------------------------------------------------
function rank(behaviorScores) {
  const scored = PHONES.map((p) => {
    const candidate = {
      overallScore: p.base.overallScore,
      matchScoreFastApi: p.base.matchScoreFastApi,
      contentSim: p.base.contentSim,
      valueScore: p.base.valueScore,
      tags: p.tags,
    };
    const { finalScore, components } = fuseOne(candidate, behaviorScores || null);
    return { id: p.id, name: p.name, finalScore, components };
  });
  scored.sort((a, b) => b.finalScore - a.finalScore);
  return scored;
}

function printRanking(title, ranked) {
  console.log(`\n=== ${title} ===`);
  console.log("Rank Phone                 Final    compat  custPref content  search  value");
  ranked.forEach((r, i) => {
    const c = r.components;
    console.log(
      String(i + 1).padEnd(5) +
      r.name.padEnd(22) +
      r.finalScore.toFixed(4).padEnd(9) +
      c.compatibility.toFixed(3).padEnd(8) +
      c.customer_preference.toFixed(3).padEnd(9) +
      c.content_similarity.toFixed(3).padEnd(9) +
      c.search_history.toFixed(3).padEnd(8) +
      c.value.toFixed(3)
    );
  });
}

function movementTable(before, after, label) {
  console.log(`\n--- Movement: baseline → ${label} ---`);
  console.log("Phone                  Before  After  Δrank  Δfinal  Δsearch_history");
  const beforeRank = new Map(before.map((r, i) => [r.id, i + 1]));
  const beforeSH = new Map(before.map((r) => [r.id, r.components.search_history]));
  const beforeFinal = new Map(before.map((r) => [r.id, r.finalScore]));
  after.forEach((r, i) => {
    const bRank = beforeRank.get(r.id);
    const aRank = i + 1;
    const dRank = bRank - aRank; // + = moved up
    const arrow = dRank > 0 ? `↑${dRank}` : dRank < 0 ? `↓${-dRank}` : "—";
    const dFinal = (r.finalScore - beforeFinal.get(r.id));
    const dSH = (r.components.search_history - beforeSH.get(r.id));
    console.log(
      r.name.padEnd(23) +
      String(bRank).padEnd(8) +
      String(aRank).padEnd(7) +
      arrow.padEnd(7) +
      (dFinal >= 0 ? "+" : "") + dFinal.toFixed(4).padEnd(8) +
      (dSH >= 0 ? "+" : "") + dSH.toFixed(4)
    );
  });
}

function dumpBehavior(label, state) {
  const dims = buildFusedWeightsSim(state.scores);
  console.log(`\n[${label}] eventCount=${state.eventCount}`);
  console.log("  BehaviorScore rows:");
  for (const [tag, score] of [...state.scores.entries()].sort((a,b)=>b[1]-a[1])) {
    console.log(`    ${tag.padEnd(22)} ${score.toFixed(4)}`);
  }
  console.log("  Fused 4-dim weights (Step C):", dims ? JSON.stringify(dims) : "null");
}

// ===========================================================================
// RUN
// ===========================================================================
console.log("FUSION_WEIGHTS:", JSON.stringify(FUSION_WEIGHTS));
console.log("confidence ramp: 1ev=%s 5ev=%s 12ev=%s 30ev=%s 45ev=%s",
  computeConfidence(1).toFixed(3), computeConfidence(5).toFixed(3),
  computeConfidence(12).toFixed(3), computeConfidence(30).toFixed(3),
  computeConfidence(45).toFixed(3));

// ---- Test 1: Baseline (fresh user, no behaviour) ----
const baseline = rank(null);
printRanking("TEST 1 — BASELINE (no behaviour)", baseline);

// ---- Test 2: Samsung preference ----
function runScenario(name, actions) {
  const st = makeBehaviorState();
  dumpBehavior(`${name} BEFORE`, st);
  let snapshotAt = 5;
  const snapshots = [];
  actions.forEach((act, idx) => {
    if (act.type === "search") recordSearchSim(st, act.q);
    else recordEventSim(st, act.type, act.phone);
    if ((idx + 1) % 5 === 0) {
      snapshots.push({ n: idx + 1, ranked: rank(st.scores), sh: new Map([...st.scores]) });
    }
  });
  dumpBehavior(`${name} AFTER`, st);
  const finalRanked = rank(st.scores);
  printRanking(`${name} — FINAL RANKING`, finalRanked);
  movementTable(baseline, finalRanked, name);
  return { st, finalRanked, snapshots };
}

const samsung = [];
for (let i=0;i<10;i++) samsung.push({ type:"search", q:"samsung galaxy ultra" });
for (let i=0;i<15;i++) samsung.push({ type:"view", phone: i%2? PHONES[1]:PHONES[0] });
for (let i=0;i<10;i++) samsung.push({ type:"compare", phone: i%2? PHONES[1]:PHONES[0] });
for (let i=0;i<10;i++) samsung.push({ type:"recommend", phone: i%2? PHONES[1]:PHONES[0] });
runScenario("TEST 2 SAMSUNG", samsung);

// ---- Test 3: Gaming preference ----
const gamingPhones = [PHONES[4], PHONES[5], PHONES[6]]; // ROG, RedMagic, iQOO
const gaming = [];
for (let i=0;i<10;i++) gaming.push({ type:"search", q:"rog gaming phone" });
for (let i=0;i<15;i++) gaming.push({ type:"view", phone: gamingPhones[i%3] });
for (let i=0;i<10;i++) gaming.push({ type:"compare", phone: gamingPhones[i%3] });
for (let i=0;i<10;i++) gaming.push({ type:"recommend", phone: gamingPhones[i%3] });
runScenario("TEST 3 GAMING", gaming);

// ---- Test 4: Camera preference ----
const cameraPhones = [PHONES[0], PHONES[9], PHONES[1]]; // S26U, Vivo X200 Pro, S25U (200MP)
const camera = [];
for (let i=0;i<10;i++) camera.push({ type:"search", q:"best camera phone" });
for (let i=0;i<15;i++) camera.push({ type:"view", phone: cameraPhones[i%3] });
for (let i=0;i<10;i++) camera.push({ type:"compare", phone: cameraPhones[i%3] });
for (let i=0;i<10;i++) camera.push({ type:"recommend", phone: cameraPhones[i%3] });
runScenario("TEST 4 CAMERA", camera);

// ---- Test 5: Battery preference ----
const batteryPhones = [PHONES[5], PHONES[6], PHONES[9]]; // RedMagic 7050, iQOO 6150, Vivo 6000
const battery = [];
for (let i=0;i<10;i++) battery.push({ type:"search", q:"long battery life phone" });
for (let i=0;i<15;i++) battery.push({ type:"view", phone: batteryPhones[i%3] });
for (let i=0;i<10;i++) battery.push({ type:"compare", phone: batteryPhones[i%3] });
for (let i=0;i<10;i++) battery.push({ type:"recommend", phone: batteryPhones[i%3] });
runScenario("TEST 5 BATTERY", battery);

// ---- Theoretical ceiling of search_history influence ----
console.log("\n=== THEORETICAL CEILING ===");
const w = FUSION_WEIGHTS.search_history;
console.log(`search_history weight = ${w}`);
console.log(`max finalScore swing from search_history alone (0.5→1.0) = ${(w*0.5).toFixed(4)}`);
console.log(`max finalScore swing worst→best (0.0→1.0)               = ${(w*1.0).toFixed(4)}`);
console.log(`compatibility+customer_pref control                    = ${(FUSION_WEIGHTS.compatibility+FUSION_WEIGHTS.customer_preference).toFixed(4)} of final`);
