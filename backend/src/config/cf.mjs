// ---------------------------------------------------------------------------
// CF (collaborative-filtering) FastAPI service URL.
//
// The CF recommender is a separate FastAPI service that loads the trained
// `cf_recommender.pkl` once at startup and exposes `/health` and
// `/recommend` on port 9001. The BE calls it over HTTP whenever a
// recommendation needs CF candidates.
//
// Why a separate config module rather than adding to `ml.mjs`:
// the existing `ML_BASE_URL` points at the rule-based / content-based
// pipeline on port 8002. Mixing the two URLs into one file would be
// confusing when reading docker-compose or .env — they have different
// failure modes (CF is a pure inference cache, ML is a learned model)
// and different Docker service names.
//
// Env var lookup:
//   CF_BASE_URL — defaults to `http://127.0.0.1:9001` for host dev.
//                 Docker compose overrides to `http://cf-service:9001`.
//                 The default is permissive: the BE never fails on boot
//                 just because the CF URL is unset — it just logs and
//                 degrades to content-only recommendations.
// ---------------------------------------------------------------------------

import "dotenv/config";

const CF_BASE_URL = process.env.CF_BASE_URL || "http://127.0.0.1:9001";

export { CF_BASE_URL };