// ---------------------------------------------------------------------------
// AUTO recommendation: multi-retriever candidate generation config.
//
// All values runtime-configurable via env. Defaults match the design
// prompt verbatim; ops canary at 10 → 50 → 100 via AUTO_MULTI_RETRIEVER_ROLLOUT_PCT
// and roll back instantly with AUTO_MULTI_RETRIEVER_ENABLED=false.
//
// Why a dedicated config module rather than extending ml.mjs: this is
// a feature flag / rollout surface, not a service URL. Mixing the two
// would make env.example harder to read for ops and would couple
// rollout state to the ML service lifecycle (boot-time throw in
// ml.mjs vs permissive defaults here — see cf.mjs for the same pattern).
//
// Env var lookup:
//   AUTO_MULTI_RETRIEVER_ENABLED       — global kill switch (default false)
//   AUTO_MULTI_RETRIEVER_ROLLOUT_PCT   — % of users on new path (default 0)
//   AUTO_FINAL_POOL_TARGET             — target pool size (default 180)
//   AUTO_PERSONA_SHARE                 — persona slice of target (default 0.28)
//   AUTO_OVERFETCH_MULTIPLIER          — over-fetch ratio (default 3)
//   AUTO_OVERFETCH_MAX                 — per-source cap (default 500)
//   AUTO_MIN_FALLBACK_POOL             — system-safety floor (default 30)
//
// Derived:
//   AUTO_PERSONA_TARGET  = round(AUTO_FINAL_POOL_TARGET * AUTO_PERSONA_SHARE)
//   AUTO_BEHAVIOR_TARGET = AUTO_FINAL_POOL_TARGET - AUTO_PERSONA_TARGET
// ---------------------------------------------------------------------------

import "dotenv/config";

const num = (key, dflt) => {
  const v = parseFloat(process.env[key]);
  return Number.isFinite(v) ? v : dflt;
};

const int = (key, dflt) => {
  const v = parseInt(process.env[key], 10);
  return Number.isInteger(v) ? v : dflt;
};

export const AUTO_MULTI_RETRIEVER_ENABLED =
  String(process.env.AUTO_MULTI_RETRIEVER_ENABLED || "").toLowerCase() === "true";

export const AUTO_MULTI_RETRIEVER_ROLLOUT_PCT = Math.min(
  100,
  Math.max(0, int("AUTO_MULTI_RETRIEVER_ROLLOUT_PCT", 0)),
);

export const AUTO_FINAL_POOL_TARGET = Math.max(
  1,
  int("AUTO_FINAL_POOL_TARGET", 180),
);

export const AUTO_PERSONA_SHARE = Math.min(
  1,
  Math.max(0, num("AUTO_PERSONA_SHARE", 0.28)),
);

export const AUTO_PERSONA_TARGET = Math.round(
  AUTO_FINAL_POOL_TARGET * AUTO_PERSONA_SHARE,
);

export const AUTO_BEHAVIOR_TARGET = Math.max(
  0,
  AUTO_FINAL_POOL_TARGET - AUTO_PERSONA_TARGET,
);

export const AUTO_OVERFETCH_MULTIPLIER = num("AUTO_OVERFETCH_MULTIPLIER", 3);

export const AUTO_OVERFETCH_MAX = Math.max(1, int("AUTO_OVERFETCH_MAX", 500));

export const AUTO_MIN_FALLBACK_POOL = Math.max(
  1,
  int("AUTO_MIN_FALLBACK_POOL", 30),
);
