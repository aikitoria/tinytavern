FROM caddy:2.11.4-builder AS caddy-build
COPY caddy /src
# Dependency bookkeeping stays in this disposable build stage.
RUN cd /src && go test -mod=mod ./...
RUN xcaddy build v2.11.4 --with minitavern/caddy=/src --output /usr/bin/caddy

FROM caddy:2.11.4-alpine AS caddy-dev
COPY --from=caddy-build /usr/bin/caddy /usr/bin/caddy
COPY --chmod=755 caddy/entrypoint.sh /usr/local/bin/minitavern-caddy
ENTRYPOINT ["/usr/local/bin/minitavern-caddy"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
COPY caddy/Caddyfile /etc/caddy/Caddyfile
COPY caddy/dev.caddy /etc/caddy/frontend.caddy
USER 1000:1000

FROM node:26-alpine AS client-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY shared shared
COPY server server
COPY client client
RUN npm run build -w client

FROM caddy-dev AS caddy-prod
COPY caddy/prod.caddy /etc/caddy/frontend.caddy
COPY --from=client-build /app/client/dist /srv
