# Future Work and Roadmap

> Living document for things still to do, structural problems to fix, and the
> best path from the current state to a finished project. Update as work is
> completed or decisions change.

## 1. Structural Problems to Fix First

These are the issues with how the project is currently set up. Tackle them
before adding new features.

### 1.1 Tech stack divergence from the proposal

**Problem.** The proposal commits to Django + Python + MySQL + XGBoost with a
React/HTML/CSS/JS frontend. The current `backend/` is Express.js + Prisma +
PostgreSQL + (planned) XGBoost via child process. If the proposal is locked in
by the department, the team must reconcile the gap. If not, the proposal
should be updated to match reality (a Node-only stack) so the report and the
code agree.

**Options.**
- *Realign to the proposal.* Move the backend to Django, switch the database
  to MySQL, and add the `xgboost` Python library. This is a substantial
  rewrite but keeps the report honest.
- *Update the proposal and report.* Treat the proposal as an early draft and
  rewrite sections 3.1.1, 3.4, and 5.2 to reflect the chosen stack
  (Express/Prisma/PostgreSQL) plus a Python ML microservice called by Node.
  This is the cheaper path and is the recommendation.

**Why it matters.** A reviewer reading the proposal will look for the
deliverables described. If the code does not match, marks are lost and the
project reads as incomplete.

### 1.2 Three unused top-level directories

**Problem.** `frontend/`, `ml/`, and `dataset/` are empty placeholders (only
`.gitkeep` in three of them, plus an abandoned `node_modules` in `frontend/`).
GitHub will render them as empty folders that confuse reviewers.

**Actions.**
- `dataset/` — add the three raw Kaggle CSV files plus the merged final
  dataset. Document source, license, and pre-processing in `dataset/README.md`.
- `ml/` — add training scripts, notebooks, model artefacts, and a
  `ml/README.md` that explains how to retrain and how to serve predictions.
- `frontend/` — either remove `node_modules` from version control (it already
  is, via `.gitkeep`) and start the React app, or replace the folder with the
  HTML/CSS/JS static site described in the proposal.

### 1.3 Dead code and debug logs in production paths

**Problem.** `userController.mjs`, `userStrategy.mjs`, `authService.mjs`, and
`userMiddleware.mjs` are full of commented-out blocks, `console.log` of
passwords and session IDs, and old strategies. A reviewer will assume the
code is unfinished.

**Actions.**
- Strip commented-out code; rely on git history for archaeology.
- Replace `console.log` with a real logger (`pino` or `winston`) and gate it
  on environment.
- Remove the `mockData/` folder once the DB-backed implementation is the only
  path; today it ships an empty `mockUsers` array.
- Standardise filenames. `stratagies/` should be `strategies/`. Either
  rename or document the typo so it is not confusing.

### 1.4 Auth is half-implemented

**Problem.** Routes for `isAuthenticate` exist but only `/products` is wired
through it. `userRoutes` is left unguarded (line 8 of `routes/main.mjs`). OTP
and forget-password logic in `authService.mjs` is duplicated and has a bug
where the resend-OTP path returns 404 for already-verified users instead of a
400 / 409. The `deleteUser` handler does not actually return the deleted
user even though it implies it.

**Actions.**
- Decide on a single policy for unauthenticated access: either everything
  except `/auth/*` requires login, or the docs say which routes are public.
- Consolidate the `verifyOtpService` and `forgetPasswordService` into a
  single transaction-safe flow. Today, two services share large chunks of
  logic.
- Fix the `resendOtpService` status codes (use `409` for "already verified",
  not `404`).
- Make `getUserById` and `deleteUser` consistent: either both return the user
  or neither does.
- Add a rate limiter on `/auth/*` to defang OTP brute-force.

### 1.5 Prisma client is generated into `src/`

**Problem.** The schema sets `output = "../src/generated/prisma"`, which
checks generated code into the source tree. The `.gitignore` ignores it, so
`config/index.mjs` will fail in a fresh clone until the developer runs
`prisma generate`.

**Actions.**
- Move the generated client out of `src/` to a non-tracked location, or keep
  it inside `src/` but commit it (or document `npm run postinstall`).
- Add a `prisma generate` step to a `db:setup` script and document it in the
  README.

### 1.6 No tests at all

**Problem.** The proposal calls for unit, integration, UAT, and performance
tests. There is no `test` script in `package.json` (it just echoes an error
and exits 1) and no test files anywhere.

**Actions.**
- Add `vitest` or `jest` for unit tests on validators, the password helper,
  and the OTP helper.
- Add `supertest` for route-level integration tests against an ephemeral
  PostgreSQL via Testcontainers or a local docker-compose.
- Add a Playwright smoke test for the UAT happy path once the frontend
  exists.

### 1.7 No deployment story

**Problem.** There is no `Dockerfile`, no `docker-compose.yml`, no CI config,
and no `.env.example` for the secrets the code already expects
(`DATABASE_URL`, `COOKIE_SECRET`, `SMTP_*`).

**Actions.**
- Add a `.env.example` listing every env var the code reads.
- Add a `docker-compose.yml` for Postgres + backend for local development.
- Add a GitHub Actions workflow that runs lint + tests on every push.

## 2. Data Work

The dataset folder is empty and the proposal depends on three datasets. Until
they land, no ML work can begin.

- [ ] Acquire the Kaggle smartphones dataset (`dilkushsingh/smartphones-dataset-upto-july24`).
- [ ] Acquire the Kaggle mobile sales dataset (`waqi786/mobile-sales-dataset`).
- [ ] Write a scraper for the Antutu phone list and produce a stable CSV.
- [ ] Document the merge logic (joins on processor and model) in
      `dataset/README.md` and check the merged CSV into `dataset/`.
- [ ] Add a small data-quality report (rows, columns, null counts, sample).

## 3. Machine Learning Work

- [ ] Set up `ml/` with a Python venv or `uv` project. Document the chosen
      toolchain in `ml/README.md`.
- [ ] Train and serialise the following XGBoost models, each with its own
      `train_*.py` script and a `models/` directory of artefacts:
  - [ ] Antutu score regression.
  - [ ] Tech tier classification (5 classes).
  - [ ] Camera preference classification (3 classes).
  - [ ] Geographic brand recommendation.
  - [ ] Brand loyalty classification.
- [ ] Persist model version + metrics (accuracy, F1, RMSE) next to each
      artefact for the "model versioning" claim in the proposal.
- [ ] Write a `predict.py` (or a small `ml/server.py`) that exposes a single
      `POST /predict` endpoint taking a JSON feature vector and returning
      scores. This is the contract the Node backend will call.
- [ ] Add SHAP feature-importance plots and embed them in the report.

## 4. Backend Work

- [ ] Add the missing domain models in `prisma/schema.prisma`:
  - [ ] `CustomerPreference` (camera tier, tech tier, location, brand affinity).
  - [ ] `Phone`, `PhoneSpec`, `BenchmarkScore`.
  - [ ] `Segment`, `SegmentMembership` (for tech tier / camera / loyalty).
  - [ ] `Recommendation`, `RecommendationItem` (history).
  - [ ] `Purchase` (for loyalty analysis).
- [ ] Wire up a `mlClient` service in Node that calls the Python predict
      service, with retries, timeouts, and a circuit breaker.
- [ ] Implement the proposal's endpoints:
  - [ ] `POST /api/predict/location` — retailer location search.
  - [ ] `POST /api/predict/phone` — given specs, return tech tier, camera tier,
        brand-loyalty pattern, and audience profile.
  - [ ] `POST /api/recommend/customer` — given a customer ID (or new-customer
        preferences), return ranked phones with match scores.
- [ ] Add role-based access control (retailer vs customer) using a
      `role` enum on `Users` (note: the `roles` table was removed in
      migration 20260610102633; reintroduce as a column for simplicity).
- [ ] Replace in-memory session-based OTP state with stateless tokens (JWT or
      signed cookies) once the rest of the auth flow stabilises.
- [ ] Add structured logging, request IDs, and a `/health` endpoint.

## 5. Frontend Work

- [ ] Decide between vanilla HTML/CSS/JS (proposal) and React (current
      `node_modules` suggests React was started). Update the proposal to
      match.
- [ ] Build the pages called out in section 2.3 of the proposal:
  - [ ] Auth pages (login, register, role select, OTP verify, forget password).
  - [ ] Retailer dashboard (location input, prediction results, audience
        insights, phone catalogue).
  - [ ] Customer portal (preferences, recommendations, phone detail).
  - [ ] Admin panel (user management, system monitoring, model metrics).
- [ ] Render recommendations as cards with: spec table, match-score badge,
      camera-tier chip, tech-tier chip, "why this phone" explanation.
- [ ] Make the site responsive down to 360 px wide.
- [ ] Add basic accessibility: alt text, focus states, colour contrast ≥ 4.5:1.

## 6. Documentation Work

- [ ] Replace the placeholder `README.md` with one that explains how to run
      the project (clone → env → migrate → start backend → start ML service →
      start frontend).
- [ ] Add `backend/README.md`, `ml/README.md`, `frontend/README.md`, and
      `dataset/README.md` with the same shape.
- [ ] Keep `Documentation/PROJECT.md` (this file's sibling) in sync with the
      code; whenever the stack changes, update both here and in the proposal.
- [ ] When the report is finalised, export it to `Documentation/final-report.pdf`
      and remove the working draft.

## 7. Recommended Path to a Finished Project

If only one path can be taken, this is the order that minimises risk and
keeps the proposal honest.

1. **Decide the stack.** Either realign to Django + Python + MySQL or update
   the proposal to "Express + Prisma + PostgreSQL with a Python ML service."
   Recommend the second; it matches the current code and avoids a rewrite.
2. **Land the data.** Acquire the three datasets, write the merge script,
   commit the merged CSV. Without this nothing else matters.
3. **Train the models.** Build the five XGBoost models one at a time. Each
   one ships with a training script, a metrics file, and a SHAP plot.
4. **Stand up the predict service.** A small Python HTTP service exposing
   `POST /predict` with feature schemas documented in OpenAPI. Verify
   end-to-end with `curl` before touching Node.
5. **Wire Node to the predict service.** Implement the three prediction
   endpoints. Add retries, timeouts, and structured errors.
6. **Build the frontend.** Either keep it simple HTML/CSS/JS (matches the
   proposal) or commit to React. Make the screens data-driven, not
   hand-curated.
7. **Test everything.** Unit tests on validators and helpers. Integration
   tests on routes with a test database. A small Playwright suite for the
   happy path. Capture the performance test results in the report.
8. **Document and deploy.** Update the proposal, write the final report, and
   ship a one-command `docker-compose up` for the demo.

Following this order means that at every step the team has something
runnable to demo, which is the safest way to finish a minor project on time.
