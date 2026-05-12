#!/usr/bin/env sh
set -e

mkdir -p /app/data

# Seed shipped JSON files into /app/data the first time only.
# User edits on the mounted volume survive across container rebuilds.
if [ ! -f /app/data/rent-fallback.json ]; then
  cp /app/seed/rent-fallback.json /app/data/rent-fallback.json
fi
if [ ! -f /app/data/neighborhoods.json ]; then
  cp /app/seed/neighborhoods.json /app/data/neighborhoods.json
fi

exec "$@"
