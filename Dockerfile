FROM node:24-bookworm-slim AS build

RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build
RUN pnpm prune --prod

FROM node:24-bookworm-slim AS runtime

# Codex needs the OS trust store for HTTPS requests to the account API.
# Node's bundled CA certificates do not provide a trust store for Codex.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global @openai/codex@0.144.1

ENV CODEX_HOME=/data/codex
ENV REDEEM_BEFORE_MINUTES=1
ENV STATE_FILE=/data/codex/.limit-auto-reset-state.json

WORKDIR /app
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

VOLUME ["/data/codex"]
CMD ["node", "dist/main.js"]
