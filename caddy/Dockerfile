FROM caddy:2.11.4-builder AS caddy-build
COPY caddy /src
# Dependency bookkeeping stays in this disposable build stage.
RUN cd /src && go test -mod=mod ./...
RUN xcaddy build v2.11.4 --with tinytavern/caddy=/src --output /usr/bin/caddy

FROM caddy:2.11.4-alpine AS caddy-dev
COPY --from=caddy-build /usr/bin/caddy /usr/bin/caddy
COPY --chmod=755 caddy/entrypoint.sh /usr/local/bin/tinytavern-caddy
ENTRYPOINT ["/usr/local/bin/tinytavern-caddy"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
COPY caddy/Caddyfile /etc/caddy/Caddyfile
COPY caddy/dev.caddy /etc/caddy/frontend.caddy
USER 1000:1000

FROM oven/bun:1.4.2-alpine AS client-build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN bun install --frozen-lockfile
COPY shared shared
COPY server server
COPY client client
RUN bun --bun run --cwd client build

FROM caddy-dev AS caddy-prod
COPY caddy/prod.caddy /etc/caddy/frontend.caddy
COPY --from=client-build /app/client/dist /srv
