# ─── Crash Game production image ───────────────────────────────────────────
#
#   docker build -t crash-game .
#
#   docker run -d --name crash-game --restart unless-stopped \
#     -p 3001:3001 \
#     -v crash-data:/app/data \
#     --env-file .env \
#     crash-game
#
# All durable data lives in Postgres (the `casino` DB) + Contabo S3. The only
# on-disk state is RocksDB (hot session cache).
#
# Volumes:
#   /app/data      RocksDB session cache (persistent — mount a named volume)
#
# Required env (pass via --env-file .env or -e; NEVER bake into the image):
#   DATABASE_URL   postgresql://casino:<pw>@<host>:5432/casino
#   S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, S3_PUBLIC_BASE
#   JWT_SECRET     required — admin/player auth fails closed without it
#   ADMIN_BOOTSTRAP_USER  "username:password:role1,role2" — seeds the first admin (idempotent)
# Optional env:
#   PORT (default 3001) · HOST (0.0.0.0) · ROCKSDB_PATH (/app/data/rocksdb) · LOG_LEVEL (info)
#
# The image ships the game (client + server) and the Creator studio. The studio
# is served on the creator host (CREATOR_HOST, default creator.games.soa.plus)
# and gated by admin login; every other host gets the game.

# ─── Build stage ───────────────────────────────────────────────────────────
# Base image pinned by digest (Task 8.3) — captured 2026-05-27 from
# `docker inspect --format='{{index .RepoDigests 0}}' node:20-slim`.
# Re-pin at each base-image upgrade.
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build

# Native build tools needed by the RocksDB binding (compiled from source the
# first time it's installed for this libc).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ libsnappy-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bring in source.
COPY . .

# Install everything (workspaces). devDeps are needed because we use tsx as
# the production runtime and Vite to build the client + creator.
RUN npm install --no-audit --no-fund

# Build the client (Vite → packages/client/dist)
RUN npm run --workspace=packages/client build

# Build the Creator studio (Vite → packages/creator/dist). Served by the same
# server on the creator host (creator.games.soa.plus), gated by admin login.
RUN npm run --workspace=packages/creator build

# ─── Runtime stage ─────────────────────────────────────────────────────────
# Same pinned digest as the build stage.
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runtime

# RocksDB dynamically loads libsnappy at runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      libsnappy1v5 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 app \
    && useradd --uid 1001 --gid app --create-home app

WORKDIR /app

# Copy everything from the build stage (sources + node_modules + client/dist)
COPY --from=build --chown=app:app /app /app

# Prepare mountable directories owned by the non-root user
RUN mkdir -p /app/data/rocksdb /app/config \
    && chown -R app:app /app/data /app/config

USER app

ENV NODE_ENV=production \
    PORT=3001 \
    ROCKSDB_PATH=/app/data/rocksdb \
    HOST=0.0.0.0

EXPOSE 3001

# OCI image metadata (Task 8.3). Fill in <owner> at release time.
LABEL org.opencontainers.image.title="Galaxy Crash" \
      org.opencontainers.image.description="B2B seamless-wallet crash game (multi-tenant)" \
      org.opencontainers.image.source="https://github.com/<owner>/crash-game" \
      org.opencontainers.image.licenses="UNLICENSED"

# HEALTHCHECK (Task 8.3) — hits the PUBLIC /api/health liveness endpoint.
# Uses Node's global fetch (stable since Node 18) to avoid adding curl/wget
# to the runtime image. PORT comes from ENV above (default 3001).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tsx handles cross-workspace TypeScript imports cleanly so we don't have to
# precompile everything to JS.
CMD ["npm", "run", "--workspace=packages/server", "start"]
