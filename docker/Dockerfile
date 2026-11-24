# syntax=docker/dockerfile:1.10
#
# Production image of marketplace-api (HW #28). Four stages, one shipped:
#
#   deps       full npm ci — the ONLY place the private-registry token exists
#   build      tsc → dist/
#   prod-deps  the same node_modules minus devDependencies
#   runtime    distroless: node + our files, no shell, no package manager
#
# Build (BuildKit):
#   docker build -f docker/Dockerfile --secret id=npm_token,src=.npm_token -t marketplace-api:hw28 .
#
# How the token is kept out of the image — the two classic leaks avoided:
#   ARG NPM_TOKEN          → lands in the image metadata (docker history /
#                            docker image inspect), forever
#   COPY .npmrc + RUN rm   → the next layer only adds a whiteout; the bytes
#                            stay in the earlier layer (docker save shows them)
# Instead: `RUN --mount=type=secret,...,env=NPM_TOKEN` — the value exists as
# an env var of that one RUN process only; it's never written to a layer
# and never recorded in the history. demo:image checks all three places.

ARG BUILD_IMAGE=node:22-bookworm-slim
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian12:nonroot

FROM ${BUILD_IMAGE} AS deps
WORKDIR /build
COPY package.json package-lock.json ./
# a template with ${NPM_TOKEN} — no secret in it
COPY docker/npmrc ./.npmrc
RUN --mount=type=secret,id=npm_token,env=NPM_TOKEN,required=true \
    --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM deps AS prod-deps
# npm expands ${NPM_TOKEN} whenever it reads .npmrc, even offline — so the
# secret is mounted here too (it's still never written anywhere)
RUN --mount=type=secret,id=npm_token,env=NPM_TOKEN,required=true \
    npm prune --omit=dev --no-audit --no-fund

# distroless: no /bin/sh, no apt, no npm — after an RCE there is nothing to
# shell into. :nonroot runs as uid 65532.
FROM ${RUNTIME_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Explicit COPYs, never `COPY . .`: only what runs is shipped (no .npmrc,
# no tests, no sources beyond the one plain-JS config module app.js needs).
# Owned by root and only readable by the app user: the process can't
# rewrite its own code.
COPY --from=prod-deps /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY package.json app.js ./
COPY src/config/env.schema.js ./src/config/env.schema.js
COPY openapi ./openapi
# NUMERIC user: kubelet can't resolve the name "nonroot" to check
# runAsNonRoot (CreateContainerConfigError: image has non-numeric user).
USER 65532:65532
EXPOSE 3000
# the distroless entrypoint is already `node`
CMD ["app.js"]
