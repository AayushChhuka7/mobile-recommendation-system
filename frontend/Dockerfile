# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Frontend — React + Vite (production)
#
# Multi-stage build:
#   1. `builder` — installs deps + runs `vite build`. The build is a static
#                  bundle in /app/dist. Vite's VITE_API_URL is read at
#                  build time and inlined into the JS — it MUST be set
#                  as an ARGs or ENV before `vite build` runs.
#   2. `runtime` — nginx:alpine serving the static dist/ folder.
#
# Why nginx over the Vite dev server:
#   * Dev server is HMR-only; not designed for production traffic.
#   * Nginx serves a static SPA with the correct SPA fallback (try_files
#     $uri /index.html) so client-side routes like /phone/123 resolve
#     without 404 on hard reload.
#   * nginx:alpine is ~40 MB, which is the smallest viable web server
#     image.
#
# VITE_API_URL handling:
#   * Vite reads `import.meta.env.VITE_API_URL` at build time and
#     inlines the value into the bundle. Build-time injection is
#     intentional — the API URL is public (no secret) and avoids a
#     runtime API call to discover it.
#   * For local Docker, set VITE_API_URL=http://localhost:8001/api.
#   * For production (Render / Railway / Fly.io / static host), set
#     VITE_API_URL=https://<your-backend>.example.com/api at build.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: builder ────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Long-cache layer: only invalidated when package*.json changes.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --loglevel=error

# Copy the rest of the source. Vite config + src + public + index.html.
COPY . .

# Build-time only. Public API URL — no secret. Defaults to localhost for
# local docker compose; override at build time for production:
#   docker build --build-arg VITE_API_URL=https://api.example.com/api .
ARG VITE_API_URL=http://localhost:8001/api
ENV VITE_API_URL=${VITE_API_URL}

# Vite production build. Output goes to /app/dist (vite's default).
RUN npm run build


# ── Stage 2: runtime (nginx) ───────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

# Remove the default nginx config + default static site so we can ship
# our own SPA-aware config.
RUN rm -rf /usr/share/nginx/html/* /etc/nginx/conf.d/default.conf

# Copy the production SPA build from the builder stage.
COPY --from=builder /app/dist /usr/share/nginx/html

# SPA-aware nginx config:
#   * try_files $uri /index.html so client-side routes don't 404 on
#     hard reload.
#   * gzip on for text payloads (saves ~70% on JS bundles).
#   * Cache-Control: immutable on assets/ so Vite's content-hashed
#     filenames are cached for a year (safe because the hash changes
#     on every code change).
#   * listen on 8080 as a non-root-friendly port for platforms that
#     refuse to bind 80 (the EXPOSE below documents this).
COPY nginx.conf /etc/nginx/conf.d/default.conf

# nginx:alpine ships its own non-root `nginx` user (uid 101). We keep it.
# 8080 is the in-container port; docker-compose publishes a host port
# on top of this.
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD ["wget", "-q", "--spider", "http://127.0.0.1:8080/"] || exit 1

CMD ["nginx", "-g", "daemon off;"]
