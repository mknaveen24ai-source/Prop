FROM node:20-alpine

# Install dumb-init for proper signal handling in containers
RUN apk add --no-cache dumb-init

WORKDIR /app

# Copy dependency files first (cache layer)
COPY package*.json ./

# Install production deps only
RUN npm ci --only=production && npm cache clean --force

# Copy source (excludes node_modules via .dockerignore)
COPY . .

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S propfirm -u 1001 && \
    chown -R propfirm:nodejs /app

USER propfirm

EXPOSE 5000

# Use dumb-init as PID 1 to forward signals correctly.
# server.js installs SIGTERM/SIGINT handlers that drain HTTP sockets and close
# Redis/Kafka/pg before exiting, so signal forwarding must work.
ENTRYPOINT ["dumb-init", "--"]

# Start the server only. Migrations run in the dedicated one-shot `migrate`
# service in docker-compose.yml, which backend waits on via
# `service_completed_successfully`. Running them here instead would race itself
# as soon as this service is scaled beyond a single replica.
CMD ["node", "server.js"]
