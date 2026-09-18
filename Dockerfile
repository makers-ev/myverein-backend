FROM node:22-alpine AS base
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 hono

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder --chown=hono:nodejs /app/dist ./dist
COPY --from=builder --chown=hono:nodejs /app/src/db/migrations ./src/db/migrations
COPY --from=builder --chown=hono:nodejs /app/assets ./assets
COPY --chown=hono:nodejs docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER hono
EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
