# Node is pinned by patch, Alpine release and multi-architecture digest so CI
# and production cannot silently move to another runtime during migration.
ARG NODE_IMAGE=node:24.19.0-alpine3.24@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

FROM ${NODE_IMAGE} AS builder

WORKDIR /build/backend

COPY contracts /build/contracts
COPY backend/package*.json ./
RUN npm ci

COPY backend/ ./
RUN npm run build && npm prune --omit=dev && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime

RUN apk add --no-cache dumb-init

WORKDIR /app

COPY backend/package*.json ./
COPY --from=builder /build/backend/node_modules ./node_modules
COPY --from=builder /build/backend/dist ./dist
COPY --from=builder /build/backend/assets ./assets

RUN addgroup -g 1001 -S nodejs && \
    adduser -S propfirm -u 1001 && \
    mkdir -p logs uploads/kyc uploads/dispute-evidence && \
    chown -R propfirm:nodejs /app

USER propfirm

EXPOSE 5000

# dumb-init remains PID 1. The shell exits into Node after the exact-runtime
# check, so SIGTERM/SIGINT still reach server.js's graceful shutdown handlers.
ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "node dist/scripts/verify-runtime-version.js && exec node --enable-source-maps dist/server.js"]
