# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/app/package.json packages/app/

# The app workspace is not needed for the API image, but npm ci wants the whole
# lockfile to resolve. Its build is skipped below.
RUN npm ci --workspace @vigilo/shared --workspace @vigilo/api --include-workspace-root

COPY packages/shared packages/shared
COPY packages/api packages/api

RUN npm run build --workspace @vigilo/shared \
  && npm run build --workspace @vigilo/api

# Drop dev dependencies from the tree we copy forward.
RUN npm prune --omit=dev --workspace @vigilo/shared --workspace @vigilo/api --include-workspace-root


FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production

RUN apk add --no-cache tini

COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/package.json package.json
COPY --from=build /repo/packages/shared/package.json packages/shared/package.json
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/packages/api/package.json packages/api/package.json
COPY --from=build /repo/packages/api/dist packages/api/dist
# Migrations are read at runtime, both to apply them and to answer /api/ready.
COPY --from=build /repo/packages/api/drizzle packages/api/drizzle

USER node
WORKDIR /repo/packages/api
EXPOSE 3000

# The break-glass CLI runs in this container too:
#   docker compose exec api npm run admin -- admin:list      (Phase 1)
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
