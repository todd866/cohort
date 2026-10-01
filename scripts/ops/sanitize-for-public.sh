#!/bin/sh

# Deprecated compatibility entrypoint. The former implementation copied broad
# trees first, rewrote text heuristically, and recursively deleted its target.
# Public exports now use the fail-closed reviewed manifest and never overwrite a
# destination.

set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: sh scripts/ops/sanitize-for-public.sh <new-output-directory>" >&2
  echo "Preferred: npm run foss:export -- <new-output-directory>" >&2
  exit 2
fi

exec node --import tsx scripts/foss/distribution.ts --export "$1"
