FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-fund --no-audit

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY ml/requirements.txt ./ml/requirements.txt
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv \
    && python3 -m venv /app/.venv \
    && /app/.venv/bin/pip install --no-cache-dir -r ml/requirements.txt \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 10001 bot && useradd --uid 10001 --gid bot --create-home bot \
    && mkdir -p /app/data && chown bot:bot /app/data
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY ml/train.py ml/archive.py ./ml/
USER bot
CMD ["node", "dist/src/main.js"]
