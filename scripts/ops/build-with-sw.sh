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

./node_modules/.bin/next build --webpack
