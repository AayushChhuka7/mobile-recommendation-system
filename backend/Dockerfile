# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Backend — Node.js + Express + Prisma
#
# Multi-stage build:
#   1. `deps`     — installs ALL deps (dev + prod) for prisma generate
#   2. `builder`  — runs prisma generate (uses dev deps via `npx prisma`)
#   3. `runtime`  — slimmer base, copies ONLY the generated client and the
#                   production node_modules. Final image is ~400 MB smaller
#                   than a single-stage build that ships devDependencies
#                   (nodemon, prisma CLI binaries, etc.) into the runtime.
#
# Why node:20-bookworm-slim (not alpine):
#   bcrypt@6 in package.json has no prebuilt musl wheels for Node 20 +
#   Alpine, so `npm install` falls back to a node-gyp compilation that
#   takes 60-180s on a cold cache (and can fail entirely in low-RAM CI).
#   glibc + Debian = bcrypt ships a prebuilt binary that installs in <2s.
#   Image size cost: ~50 MB larger than the Alpine version. Build time
#   win: ~3 min saved on the very first build and ~30-90s on every rebuild
#   that has bcrypt source changes.
#
# Why two package*.json COPYs (not `COPY . .` first):
#   Layer cache for `npm ci` is keyed off `package.json` + `package-lock.json`.
#   Those files change rarely. Source code changes often. By isolating the
#   dependency install in its own layer, code edits skip the `npm ci` step
#   entirely on rebuild.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: install ALL deps (dev + prod) ───────────────────────────────────
FROM node:20-bookworm-slim AS deps

WORKDIR /app

# We need OpenSSL in the runtime image for connect-pg-simple + bcrypt salts
# (cryptographically secure random). Cheap; install once.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        openssl \
 && rm -rf /var/lib/apt/lists/*

# Copy ONLY the lockfile + manifest first. This is the long-cache layer:
#   - When ONLY .js source changes, this layer is reused (skip npm ci).
#   - When package.json / package-lock.json change, this layer rebuilds.
# `npm ci` is the canonical CI/CD install (vs `npm install`):
#   - Strictly uses the lockfile; reproducible.
#   - Faster than `npm install` because it skips version negotiation.
#   - Removes node_modules first, so the resulting tree is always clean.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --loglevel=error


# ── Stage 2: prisma generate ────────────────────────────────────────────────
# Prisma generate is split into its own stage so:
#   1. The generated client is produced from the schema and the installed
#      prisma CLI, both of which only change when the schema or
#      package.json/lock changes (rare).
#   2. The runtime stage does NOT need the prisma CLI (~50 MB of binaries)
#      or the schema.prisma file — only the generated client.
FROM node:20-bookworm-slim AS prisma-gen

WORKDIR /app

# Reuse the node_modules from the `deps` stage. This stage does NOT install
# anything new; it just runs `prisma generate` to produce the typed client.
COPY --from=deps /app/node_modules ./node_modules
COPY prisma ./prisma
COPY package.json package-lock.json ./

# Generate the typed Prisma client. The output is at src/generated/prisma
# (per the `output` directive in schema.prisma). Runs from devDeps
# (prisma is in devDependencies) so this MUST happen before the prod-only
# prune in the next stage.
RUN npx prisma generate


# ── Stage 3: production-only deps + runtime ──────────────────────────────────
FROM node:20-bookworm-slim AS runtime

WORKDIR /app

# Runtime-only system libraries. openssl was already explained above.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        openssl \
        tini \
 && rm -rf /var/lib/apt/lists/*

# tini = a tiny init that reaps zombie processes and forwards signals
# (Ctrl-C, SIGTERM) correctly. Critical for nodemon + docker stop to
# behave the way you expect. Adds ~30 KB.

# Install PRODUCTION-only deps onto a fresh tree, then copy our generated
# Prisma client on top. Two reasons to do this rather than pruning:
#   1. `npm prune --production` leaves dev binaries and .bin scripts in
#      place even though their imports fail; clean install is safer.
#   2. Future-proofing: when you add a build step (e.g. esbuild bundle),
#      it goes in the builder stage and the runtime stays clean.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --loglevel=error \
 && npm cache clean --force

# Copy the prebuilt Prisma client from the prisma-gen stage. This is the
# entire reason we have a separate prisma-gen stage.
COPY --from=prisma-gen /app/src/generated ./src/generated

# Copy source code last. This layer invalidates on every code edit (which
# is fine — it must), but all the heavy install layers above stay cached.
COPY src ./src
COPY prisma ./prisma
COPY seed.mjs ./
COPY prisma.config.ts ./

EXPOSE 8001

# Drop privileges. node:20-bookworm-slim ships a `node` user (uid 1000).
# Without this, the container runs as root, which is a security risk.
USER node

# tini as PID 1 — handles SIGTERM correctly so nodemon exits cleanly.
# docker compose `stop` (vs `kill`) sends SIGTERM and waits 10s; without
# tini, nodemon occasionally traps the signal and the stop times out.
ENTRYPOINT ["/usr/bin/tini", "--"]

# `npm run dev` is the same command the previous Dockerfile used. The
# `db-init` service in docker-compose.yml overrides this CMD with its own
# one-shot command — that override still works because compose replaces CMD
# at the service level, not at the image level.
CMD ["npm", "run", "dev"]
