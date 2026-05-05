# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Inject branding at build time via build args
ARG VITE_API_URL
ARG VITE_FIRM_NAME
ARG VITE_PRIMARY_COLOR
ARG VITE_SUPPORT_EMAIL

ENV VITE_API_URL=$VITE_API_URL
ENV VITE_FIRM_NAME=$VITE_FIRM_NAME
ENV VITE_PRIMARY_COLOR=$VITE_PRIMARY_COLOR
ENV VITE_SUPPORT_EMAIL=$VITE_SUPPORT_EMAIL

RUN npm run build

# ── Stage 2: Serve ────────────────────────────────────────────────────────────
FROM nginx:1.25-alpine

# Copy built React app
COPY --from=builder /app/build /usr/share/nginx/html

# Copy nginx config for SPA routing
COPY nginx-spa.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
