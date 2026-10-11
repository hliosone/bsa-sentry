# One image for the server and the merchants (same code, different entry point), so the
# deployed topology is exactly what docker-compose runs locally.
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/merchants ./apps/merchants
COPY apps/web/package.json ./apps/web/package.json
COPY apps/web/src/bridge ./apps/web/src/bridge
RUN pnpm install --frozen-lockfile --filter @bsa-sentry/server... --filter @bsa-sentry/merchants...
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@bsa-sentry/server", "start"]
