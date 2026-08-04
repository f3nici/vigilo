# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/app/package.json packages/app/

RUN npm ci --workspace @vigilo/shared --workspace @vigilo/app --include-workspace-root

COPY packages/shared packages/shared
COPY packages/app packages/app

RUN npm run build --workspace @vigilo/shared \
  && npm run build --workspace @vigilo/app


FROM nginx:1.27-alpine AS runtime

# Source-available, not open source. Commercial use needs written permission.
LABEL org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0" \
  org.opencontainers.image.vendor="Fenici" \
  org.opencontainers.image.source="https://github.com/f3nici/vigilo"

COPY --from=build /repo/packages/app/dist /usr/share/nginx/html
COPY packages/app/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
