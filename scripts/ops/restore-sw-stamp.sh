#!/bin/sh
# Restore the __BUILD_STAMP__ placeholder after a local build so the concrete
# stamped SHA isn't accidentally committed — committing it freezes the service
# worker (every deploy ships a byte-identical sw.js and browsers never update).
#
# On Vercel the stamped file MUST persist into the deployment artifact, so skip
# the restore there.
[ -n "$VERCEL" ] && exit 0

SW_FILE="${1:-public/sw.js}"
[ -f "$SW_FILE" ] || exit 0

sed "s|^// build: .*|// build: __BUILD_STAMP__|" "$SW_FILE" > "$SW_FILE.tmp" && mv "$SW_FILE.tmp" "$SW_FILE"
