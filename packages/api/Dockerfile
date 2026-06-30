FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache jq

COPY package.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/api/package.json packages/api/

# Trim workspaces to api+sdk only (drop frontend + shared which aren't
# shipped in the container). Avoids fetching the heavy frontend tree.
RUN jq '.workspaces = ["packages/api","packages/sdk"]' package.json > /tmp/p.json && \
    mv /tmp/p.json package.json && \
    npm install --no-package-lock

COPY packages/sdk packages/sdk
COPY packages/api packages/api
RUN npm run sdk:build && npm run api:build

# ─── runtime image ──────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache wget
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=build /app/packages/sdk/package.json ./packages/sdk/
COPY --from=build /app/packages/api/dist ./packages/api/dist
COPY --from=build /app/packages/api/package.json ./packages/api/
# `@openx/sdk` resolves via npm workspaces symlink; preserve it.
COPY --from=build /app/node_modules/@openx ./node_modules/@openx
EXPOSE 3001
WORKDIR /app/packages/api
CMD ["node", "dist/server.js"]
