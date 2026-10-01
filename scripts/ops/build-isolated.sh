#!/bin/sh

set -eu

ROOT_DIR=$(cd "$(dirname "$0")/../.." && pwd)
TMP_DIR=$(mktemp -d /tmp/md3-build-XXXXXX)

cleanup() {
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT INT TERM

rsync -a \
  --exclude '.git' \
  --exclude '.next' \
  --exclude '.next-build' \
  --exclude 'node_modules' \
  --exclude 'reels-inbox' \
  "$ROOT_DIR/" "$TMP_DIR/"

ln -s "$ROOT_DIR/node_modules" "$TMP_DIR/node_modules"

cd "$TMP_DIR"

prisma generate
node scripts/content/generate-deep-dive-manifest.mjs
node scripts/content/generate-deep-dive-cards-manifest.mjs
MD3_GENERATED_CONTENT_MODE=${MD3_GENERATED_CONTENT_MODE:-offline} node --import tsx scripts/content/generate-content-map.ts
MD3_GENERATED_CONTENT_MODE=${MD3_GENERATED_CONTENT_MODE:-offline} node --import tsx scripts/content/generate-starter-sessions.ts
MD3_GENERATED_CONTENT_MODE=${MD3_GENERATED_CONTENT_MODE:-offline} node --import tsx scripts/images/build-index.ts
sh scripts/ops/stamp-sw.sh
next build --webpack
