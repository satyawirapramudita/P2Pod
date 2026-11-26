# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/discovery-platform/package.json packages/discovery-platform/
COPY packages/user-client/package.json packages/user-client/
COPY packages/web-ui/package.json packages/web-ui/

# --ignore-scripts avoids the workspace postinstall before sources exist.
RUN npm ci --ignore-scripts

COPY . .
RUN npm run patch:css && npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN mkdir -p /data && chown -R node:node /data

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/packages/discovery-platform/package.json ./packages/discovery-platform/package.json
COPY --from=build --chown=node:node /app/packages/discovery-platform/dist ./packages/discovery-platform/dist
COPY --from=build --chown=node:node /app/packages/user-client/package.json ./packages/user-client/package.json
COPY --from=build --chown=node:node /app/packages/user-client/dist ./packages/user-client/dist
COPY --from=build --chown=node:node /app/packages/web-ui/package.json ./packages/web-ui/package.json
COPY --from=build --chown=node:node /app/packages/web-ui/dist ./packages/web-ui/dist

USER node
EXPOSE 3333 5000

FROM runtime AS discovery
ENV PORT=4000
EXPOSE 4000
CMD ["node", "packages/discovery-platform/dist/index.js"]

FROM runtime AS web
ENV P2POD_UI_HOST=0.0.0.0 \
    P2POD_UI_PORT=3333 \
    P2POD_HOME=/data/profile \
    P2POD_DATA_DIR=/data/profiles \
    P2POD_STATE_DIR=/data/state \
    P2POD_CSS_DIR=/data/css
CMD ["node", "packages/user-client/dist/main.js", "web", "--no-open"]