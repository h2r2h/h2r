FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:22-alpine

ARG VERSION
ARG SEMVER_CORE
ARG COMMIT_SHA
ARG GITHUB_REPO
ARG BUILD_DATE

LABEL org.opencontainers.image.source=${GITHUB_REPO}
LABEL org.opencontainers.image.created=${BUILD_DATE}
LABEL org.opencontainers.image.version=${VERSION}
LABEL org.opencontainers.image.revision=${COMMIT_SHA}

ENV VERSION=${VERSION} \
    SEMVER_CORE=${SEMVER_CORE} \
    COMMIT_SHA=${COMMIT_SHA} \
    BUILD_DATE=${BUILD_DATE} \
    GITHUB_REPO=${GITHUB_REPO}

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

RUN addgroup -g 1001 -S app && \
    adduser -u 1001 -S app -G app && \
    chown -R app:app /app

USER app

ENV NODE_ENV=production

EXPOSE 8080 9100

CMD ["node", "dist/index.js"]
