#!/bin/sh
# Stamp public/sw.js with the build SHA, run the Next build, and ALWAYS restore
# the __BUILD_STAMP__ placeholder afterwards — on success OR failure — via an
# EXIT trap.
#
# Why: the build chain used `stamp && next build && restore`. If `next build`
# failed (e.g. a stale .next webpack crash), restore never ran, leaving a
# concrete stamped SHA in the working tree. Committing that freezes the service
# worker forever (every deploy ships a byte-identical sw.js, so browsers never
# update). Codex hit exactly this on 2026-05-21. The trap closes that hole.
#
# On Vercel restore-sw-stamp.sh no-ops ($VERCEL set), so the stamped artifact
# still ships into the deployment.
set -e

SW_FILE="${1:-public/sw.js}"

sh scripts/ops/stamp-sw.sh "$SW_FILE"
trap 'sh scripts/ops/restore-sw-stamp.sh "$SW_FILE"' EXIT

# Local release builds OOM at Node's default ~4.1 GB heap. `npm run build`
# survives it, but `build:release` regenerates the content map, starter
# sessions and image index in release mode first, so the Next build has
# materially more to hold — on 2026-08-22 it died with "Ineffective
# mark-compacts near heap limit" at 4079 MB during the TypeScript pass.
#
# Same shape as the vitest heap fix in 846713bc, and deliberately local-only:
# Vercel sizes its own build container and may set NODE_OPTIONS itself, so an
# existing value always wins and $VERCEL builds are left byte-identical.
if [ -z "$VERCEL" ] && [ -z "$NODE_OPTIONS" ]; then
  NODE_OPTIONS="--max-old-space-size=8192"
  export NODE_OPTIONS
fi

./node_modules/.bin/next build --webpack
