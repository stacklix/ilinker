FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.app.json tsconfig.server.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
COPY server ./server
COPY shared ./shared
RUN npm run build && npm prune --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data ILINKER_LOCAL_CLI_FILE=/tmp/ilinker-local-cli.token
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data \
    && chmod +x /app/dist/server/cli.js \
    && ln -s /app/dist/server/cli.js /usr/local/bin/ilinker
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "dist/server/healthcheck.js"]
CMD ["node", "dist/server/index.js"]
