# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Build-time config. Vite inlines import.meta.env.VITE_* at build time, so these
# must be present here — they cannot be injected at container runtime.
#
# VITE_API_URL is deliberately allowed to be empty: it is the axios baseURL and
# every call path already begins with /api/..., so behind the same-origin nginx
# proxy an empty value is the correct one.
#
# Branding (firm name, colours, support email) is NOT built in — it is fetched at
# runtime from the API by BrandingContext. Do not re-add VITE_FIRM_NAME et al.
# VITE_FX_CONVERSION_ENABLED must track the backend's FX_CONVERSION_ENABLED.
# src/utils/instruments.js reads it to decide which instruments may be opened;
# the backend restricts the same set. It was read by the app but declared
# nowhere, so a cutover would have flipped the backend while the frontend kept
# silently restricting instruments. docker-compose passes the backend's value.
ARG VITE_API_URL=""
ARG VITE_APP_VERSION=1.0.0
ARG VITE_SENTRY_DSN=""
ARG VITE_FX_CONVERSION_ENABLED="false"

ENV VITE_API_URL=$VITE_API_URL
ENV VITE_APP_VERSION=$VITE_APP_VERSION
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
ENV VITE_FX_CONVERSION_ENABLED=$VITE_FX_CONVERSION_ENABLED

RUN npm run build

# ── Stage 2: Serve ────────────────────────────────────────────────────────────
FROM nginx:1.25-alpine

# Copy built React app
COPY --from=builder /app/build /usr/share/nginx/html

# Copy nginx config for SPA routing
COPY nginx-spa.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
