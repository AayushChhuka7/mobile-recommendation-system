# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Backend — Node.js + Express + Prisma (Prisma 7)
#
# Multi-stage build:
#   1. `deps`      — installs ALL deps (dev + prod) so `prisma generate`
#                    has the prisma CLI available.
#   2. `prisma`    — runs `npx prisma generate` to produce the typed
#                    client at src/generated/prisma (see `output` in
#                    schema.prisma). Uses devDeps from the `deps` stage.
#   3. `runtime`   — slim base with PRODUCTION-only node_modules + the
#                    prebuilt Prisma client. No prisma CLI binaries, no
#                    nodemon.
#
# Why node:20-bookworm-slim (not alpine):
#   bcrypt@6 in package.json has no prebuilt musl wheels for Node 20 +
#   Alpine, so `npm install` falls back to a node-gyp compilation that
#   takes 60-180s on a cold cache (and can fail entirely in low-RAM CI).
#   glibc + Debian = bcrypt ships a prebuilt binary that installs in <2s.
#
# Production CMD notes (Prisma 7):
#   * `prisma migrate deploy` is the canonical production migration
#     command — it applies pending migrations WITHOUT creating new ones
#     and WITHOUT resetting the database. We do NOT call it at container
#     start (it can run on app boot via a separate one-shot job — see
#     docker-compose.yml `db-migrate` profile or the deploy guide).
#   * `prisma db push` is NOT used in production (it's for prototyping
#     and can cause data loss).
#   * `prisma migrate dev` is NEVER used in production (creates new
#     migrations interactively).
#
# PORT handling:
#   The runtime CMD starts the Express app via `node src/index.mjs`,
#   which reads `process.env.PORT` (default 8001). The container EXPOSES
#   8001 but the runtime port is whatever the platform / compose
#   provides — Render, Railway, Fly.io, and AWS App Runner all set
#   PORT automatically and our code already respects it.
#
# Runtime hardening:
#   * Runs as the unprivileged `node` user (uid 1000) shipped by the base
#     image. No need to run as root in production.
#   * `tini` is PID 1 so SIGTERM is forwarded correctly and containers
#     shut down within docker compose's 10s grace window.
#   * `.env` files are NEVER COPY'd — see backend/.dockerignore.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: install ALL deps (dev + prod) ───────────────────────────────────
FROM node:20-bookworm-slim AS deps

WORKDIR /app

# openssl: bcrypt salts + connect-pg-simple need cryptographically secure RNG.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        openssl \
 && rm -rf /var/lib/apt/lists/*

# Long-cache layer: only invalidated when package*.json changes.
COPY package.json package-lock.json ./
# `npm ci` is reproducible, faster than `npm install`, and never mutates
# the lockfile. Both devDeps (prisma CLI, nodemon) and prod deps are
# installed here so the next stage can run `prisma generate`.
RUN npm ci --no-audit --no-fund --loglevel=error


# ── Stage 2: prisma generate ────────────────────────────────────────────────
# Produces the typed Prisma client from schema.prisma. Output path is
# declared by the `output` directive in schema.prisma
# (../src/generated/prisma relative to schema.prisma = /app/src/generated/prisma).
# This stage does NOT install anything new; it reuses the devDeps from `deps`.
FROM node:20-bookworm-slim AS prisma-gen

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY prisma ./prisma
COPY package.json package-lock.json ./
COPY prisma.config.ts ./

# Generate the Prisma client. Prisma 7 reads DATABASE_URL from prisma.config.ts
# (which itself imports dotenv/config), so a real DATABASE_URL must be
# available at build time for the generator to introspect the datasource.
# We pass it via build-arg so it never ends up in the runtime layer.
ARG DATABASE_URL
ENV DATABASE_URL=${DATABASE_URL}

RUN npx prisma generate


# ── Stage 3: production-only deps + runtime ──────────────────────────────────
FROM node:20-bookworm-slim AS runtime

WORKDIR /app

# Runtime-only system libraries: openssl (bcrypt / session) + tini (init).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        openssl \
        tini \
 && rm -rf /var/lib/apt/lists/*

# PRODUCTION-only deps on a fresh tree. Two reasons over `npm prune`:
#   1. `npm prune --production` leaves dev .bin stubs behind.
#   2. The runtime stage must NOT contain the prisma CLI or nodemon.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --loglevel=error \
 && npm cache clean --force

# Copy the prebuilt Prisma client from the prisma-gen stage.
COPY --from=prisma-gen /app/src/generated ./src/generated

# Copy the schema + config + seeds + source. Schema is small and is
# needed if `prisma migrate deploy` is invoked at runtime from the image.
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY seed.mjs seedAdmin.mjs ./
COPY src ./src

EXPOSE 8001

# Drop privileges: node:20-bookworm-slim ships a `node` user (uid 1000).
USER node

# tini as PID 1 — handles SIGTERM cleanly so `docker compose stop` and
# cloud-platform shutdown signals exit the app within the grace window.
ENTRYPOINT ["/usr/bin/tini", "--"]

# PRODUCTION command — `node src/index.mjs` is the existing app entry,
# not nodemon. The PORT env var is read by index.mjs (defaults to 8001).
# The `db-init` service in docker-compose.yml overrides this CMD with
# its own one-shot seed command — that override still works because
# compose replaces CMD at the service level, not at the image level.
CMD ["node", "src/index.mjs"]
