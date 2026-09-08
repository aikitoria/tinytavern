FROM node:26-alpine AS server-base
RUN apk add --no-cache ffmpeg
WORKDIR /app

FROM server-base AS server-prod
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=5487
COPY package.json package-lock.json ./
COPY shared shared
COPY server server
COPY client/package.json client/
RUN npm ci --omit=dev
VOLUME /data
EXPOSE 5487
CMD ["node", "server/src/index.ts"]
