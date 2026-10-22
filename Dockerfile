# Primes Auto — RO Workflow portal
# Zero npm dependencies: nothing to install, just copy the app in.
FROM node:22-alpine
RUN apk add --no-cache su-exec
ENV NODE_ENV=production PORT=8090 HOST=0.0.0.0 \
    DB_FILE=/app/data/ro-workflow.sqlite CONFIG_DIR=/app/data
WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /app/data && chown -R node:node /app && chmod +x /app/scripts/docker-entrypoint.sh
# The container starts as root only so it can fix ownership of a freshly mounted volume
# (hosted volumes are root-owned), then drops to the unprivileged "node" user.
VOLUME ["/app/data"]
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT:-8090}/api/session >/dev/null || exit 1
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
