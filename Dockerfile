# One image for the server (which also serves the website) and the merchants, so the deployed
# topology is exactly what docker-compose runs locally.

# pnpm always installs the workspace root, whose dev tooling includes the USB transport for the
# hardware smoke test. `--ignore-scripts` keeps its native build (node-hid, usb) out of the image:
# nothing here talks to a device, and pnpm 10 already skips every other install script.

# --- build the website ------------------------------------------------------------------
FROM node:22-slim AS web
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @bsa-sentry/web... \
 && pnpm --filter @bsa-sentry/web build

# --- runtime ------------------------------------------------------------------------------
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/merchants ./apps/merchants
COPY apps/web/package.json ./apps/web/package.json
COPY apps/web/src/bridge ./apps/web/src/bridge
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @bsa-sentry/server... --filter @bsa-sentry/merchants...
COPY --from=web /app/apps/web/dist ./apps/web/dist
ENV NODE_ENV=production WEB_DIST=/app/apps/web/dist
# One image, two roles: BSA_ROLE=merchants runs the demo shops (Railway sets it per service;
# docker-compose passes its own command instead).
CMD ["sh", "-c", "if [ \"$BSA_ROLE\" = merchants ]; then exec pnpm --filter @bsa-sentry/merchants start; else exec pnpm --filter @bsa-sentry/server start; fi"]
