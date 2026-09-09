FROM oven/bun:1.4.2-alpine AS server-base
USER root
RUN apk add --no-cache ffmpeg && mkdir -p /app && chown 1000:1000 /app
WORKDIR /app
USER 1000:1000
ENTRYPOINT []

# Shared dependency image for isolated tools, tests and the development servers.
FROM server-base AS tools
COPY --chown=1000:1000 package.json bun.lock bunfig.toml ./
COPY --chown=1000:1000 shared/package.json shared/
COPY --chown=1000:1000 server/package.json server/
COPY --chown=1000:1000 client/package.json client/
RUN bun install --frozen-lockfile

FROM server-base AS server-prod
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=5487
COPY --chown=1000:1000 package.json bun.lock bunfig.toml ./
COPY --chown=1000:1000 shared/package.json shared/
COPY --chown=1000:1000 server/package.json server/
COPY --chown=1000:1000 client/package.json client/
RUN bun install --frozen-lockfile --production
COPY --chown=1000:1000 shared shared
COPY --chown=1000:1000 server server
VOLUME /data
EXPOSE 5487
CMD ["bun", "server/src/index.ts"]
