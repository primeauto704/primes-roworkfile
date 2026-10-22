#!/bin/sh
# Make the data volume writable by the app user, then run as that user.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data
  chown -R node:node /app/data 2>/dev/null || true
  exec su-exec node "$@"
fi
exec "$@"
