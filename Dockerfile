# ─── Galaxy Crash production image ─────────────────────────────────────────
#
#   docker build -t galaxy-crash .
#
#   docker run -d --name galaxy-crash \
#     -p 3001:3001 \
#     -v $(pwd)/config:/app/config:ro \
#     -v galaxy-crash-data:/app/data \
#     galaxy-crash
#
# Volumes:
#   /app/data      RocksDB session store (persistent — mount a named volume)
#   /app/config    Drop active-theme.json here to set the operator theme
#
# Env:
#   PORT           default 3001
#   ROCKSDB_PATH   default /app/data/rocksdb
#
# The image ships the game (client + server) only. The Creator stays a
# dev-time tool — players can't reach it and can't override the theme.

# ─── Build stage ───────────────────────────────────────────────────────────
FROM node:20-slim AS build

# Native build tools needed by the RocksDB binding (compiled from source the
# first time it's installed for this libc).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ libsnappy-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bring in source. The Creator package is deleted before install so it isn't
# baked into the production image at all.
COPY . .
RUN rm -rf packages/creator

# Install everything (workspaces). devDeps are needed because we use tsx as
# the production runtime and Vite to build the client.
RUN npm install --no-audit --no-fund

# Build the client (Vite → packages/client/dist)
RUN npm run --workspace=packages/client build

# ─── Runtime stage ─────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

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

# tsx handles cross-workspace TypeScript imports cleanly so we don't have to
# precompile everything to JS.
CMD ["npm", "run", "--workspace=packages/server", "start"]
