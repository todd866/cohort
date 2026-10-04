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
# Same shape as the vitest heap fix in 846713bc.
#
# Vercel builds run on the Standard machine (4 cores, 8 GB) since 2026-10-02,
# because Standard builds are not billed per CPU-minute and the 30-core machine
# Elastic had picked sat idle for most of each build. Node's default heap there
# is about a quarter of RAM, ~2 GB, under the ~4.2 GB the TypeScript pass
# needs, so a Vercel build gets 6 GB: enough for that pass, with room left for
# the rest of the build. An existing NODE_OPTIONS always wins.
if [ -z "$NODE_OPTIONS" ]; then
  if [ -n "$VERCEL" ]; then
    NODE_OPTIONS="--max-old-space-size=6144"
  else
    NODE_OPTIONS="--max-old-space-size=8192"
  fi
  export NODE_OPTIONS
fi

./node_modules/.bin/next build --webpack
