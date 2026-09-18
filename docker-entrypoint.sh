#!/bin/sh
set -e

echo "[entrypoint] running database migrations..."
node dist/db/migrate.js

echo "[entrypoint] starting server..."
exec "$@"
