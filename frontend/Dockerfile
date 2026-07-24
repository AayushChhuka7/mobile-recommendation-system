# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Frontend — React + Vite
#
# Single-stage build (intentional):
#   Vite is a dev server in the compose stack today (`npm run dev`). The
#   "production" build (`npm run build`) outputs to dist/, which the compose
#   file does not serve. We deliberately keep the dev runtime so HMR works
#   for `docker compose up` devs. When you add a production compose profile,
#   add a second stage here that runs `npm run build` and serves dist/ via
#   nginx.
#
# Why node:20-alpine is fine here:
#   No native-build deps in package.json (no bcrypt, no sqlite, no native
#   canvas). Everything is pure JS or Vite plugins. Alpine's smaller size
#   (~50 MB saved vs Bookworm Slim) is a free win with no build-time cost.
#
# Why `npm ci` instead of `npm install`:
#   `npm ci` is reproducible (uses lockfile verbatim), ~30% faster, and
#   never silently mutates package-lock.json. For CI/CD this is the only
#   correct choice.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-alpine

WORKDIR /app

# Copy ONLY the lockfile + manifest first. This is the long-cache layer:
#   - When ONLY .js/.jsx source changes, this layer is reused.
#   - When package.json / package-lock.json change, this layer rebuilds.
COPY package.json package-lock.json ./

# --no-audit --no-fund cuts npm's output noise and shaves a couple seconds
# of network round-trips to the npm audit endpoint on every build.
# --loglevel=error only shows failures.
RUN npm ci --no-audit --no-fund --loglevel=error \
 && npm cache clean --force

# Copy the rest of the source. Source changes invalidate this layer (which
# is correct — we want a fresh copy on code change), but the heavy
# `npm ci` layer above is preserved.
COPY . .

# Vite's HMR (hot module reload) runs a WebSocket inside the container.
# On Mac/Windows hosts, Docker's file-watcher doesn't see the host's file
# events, so HMR hangs unless Vite falls back to polling. The
# CHOKIDAR_USEPOLLING=true env var forces that fallback.
ENV CHOKIDAR_USEPOLLING=true

EXPOSE 5173

# `--host 0.0.0.0` makes Vite listen on all interfaces inside the container,
# which is what makes the host's `localhost:5173` mapping work.
# (The browser still uses `http://localhost:8001/api` for the API; the FE's
#  VITE_API_URL is build-time-injected by docker-compose.yml.)
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
