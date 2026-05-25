#!/bin/sh
set -eu

DATABASE_URL="${DATABASE_URL:-file:/tmp/pwa-ai-coach.db}"
UPLOAD_DIR="${UPLOAD_DIR:-/tmp/uploads}"

export DATABASE_URL
export UPLOAD_DIR

mkdir -p "$UPLOAD_DIR"

case "$DATABASE_URL" in
  file:*)
    DB_PATH="${DATABASE_URL#file:}"
    mkdir -p "$(dirname "$DB_PATH")"
    ;;
esac

pnpm prisma migrate deploy
node dist/seed.js
exec node dist/server.js
