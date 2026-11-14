# BEAN Folio — production container (M22 Phase 2, O3)
#
# Multi-stage build producing the Next.js standalone server against the
# PostgreSQL schema mirror (the same schema `vercel-build` uses, so both
# approved deployment paths run identical data-model code).
#
# Build:  docker build -t bean-folio .
# Run:    see docker-compose.yml (app + postgres + Caddy TLS proxy)
#
# Required runtime env (validated at startup — src/lib/startup-validation.ts):
#   DATABASE_URL=postgresql://...            (append ?connection_limit=10&pool_timeout=10 behind a pooler)
#   NEXT_PUBLIC_APP_URL=https://<origin>     (baked at build time — pass as build arg and env)
# Optional: S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY (all-or-nothing),
#   QUEUE_ENABLED, RATE_LIMIT_BACKEND=postgres, CACHE_BACKEND, LOG_LEVEL, ERROR_WEBHOOK_URL.

# ---------------------------------------------------------------------------
# 1. Builder — install, generate the PostgreSQL Prisma client, build standalone
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder
WORKDIR /app

# pdf-parse is a serverExternalPackage; deps install is plain npm-compatible.
COPY package.json bun.lock ./
RUN corepack enable && bun --version 2>/dev/null || npm install -g bun \
  && bun install --frozen-lockfile

COPY prisma ./prisma
RUN bunx prisma generate --schema prisma/schema.postgres.prisma

COPY . .
# NEXT_PUBLIC_APP_URL is inlined into the client bundle at build time.
ARG NEXT_PUBLIC_APP_URL=""
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} NEXT_TELEMETRY_DISABLED=1
# Same output the repo's build script produces: standalone + static + public copies.
RUN bunx --bun next build \
  && cp -r .next/static .next/standalone/.next/ \
  && cp -r public .next/standalone/

# ---------------------------------------------------------------------------
# 2. Runner — minimal image, non-root, health-checked
# ---------------------------------------------------------------------------
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1

# Local-disk media fallback (prefer S3 in production; see startup validation).
RUN mkdir -p /app/uploads && chown -R node:node /app
USER node

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
# Prisma client + engines (output file tracing covers most; copy explicitly
# so the generated POSTGRES client is guaranteed present).
COPY --from=builder --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=node:node /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=node:node /app/prisma/schema.postgres.prisma ./prisma/schema.postgres.prisma

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Graceful shutdown: instrumentation.ts handles SIGTERM (queue drain, ≤27s hard cap).
STOPSIGNAL SIGTERM
CMD ["node", "server.js"]
