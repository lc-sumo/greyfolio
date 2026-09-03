# Greystone commission portal — API + built portal in one image.
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY lib/commission/package.json lib/commission/
COPY lib/db/package.json lib/db/
COPY artifacts/api-server/package.json artifacts/api-server/
COPY artifacts/portal/package.json artifacts/portal/
RUN pnpm install --frozen-lockfile
COPY lib lib
COPY artifacts artifacts
RUN pnpm --filter @greystone/portal build

FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=development PORT=8080 PORTAL_DIST=/app/artifacts/portal/dist
EXPOSE 8080
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
