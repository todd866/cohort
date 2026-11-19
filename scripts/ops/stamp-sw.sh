#!/bin/sh
# Stamp sw.js with the current git commit so every deploy triggers a SW update.
# The tracked file holds a __BUILD_STAMP__ placeholder; this replaces it at build
# time. restore-sw-stamp.sh puts the placeholder back after local builds so the
# stamped SHA is never committed (a committed stamp freezes the SW forever).
SW_FILE="${1:-public/sw.js}"

if [ ! -f "$SW_FILE" ]; then
  echo "Warning: $SW_FILE not found, skipping stamp"
  exit 0
fi

# Fail loudly instead of silently no-opping: a missing placeholder means the file
# is already stamped (frozen) — shipping it would leave the SW un-updatable.
if ! grep -q '__BUILD_STAMP__' "$SW_FILE"; then
  echo "Error: $SW_FILE has no __BUILD_STAMP__ placeholder — it looks already-stamped (frozen SW)." >&2
  echo "Recover with: git checkout -- $SW_FILE" >&2
  exit 1
fi

# A checked-out Git HEAD is authoritative. CLI deployment archives may omit
# .git while Vercel supplies the immutable commit as build metadata instead.
if STAMP=$(git rev-parse --short HEAD 2>/dev/null); then
  :
elif [ -n "${VERCEL_GIT_COMMIT_SHA:-}" ]; then
  case "$VERCEL_GIT_COMMIT_SHA" in
    *[!0-9a-fA-F]*) echo "Error: invalid Vercel commit identity" >&2; exit 1 ;;
  esac
  if [ "${#VERCEL_GIT_COMMIT_SHA}" -ne 40 ]; then
    echo "Error: Vercel commit identity must be a full SHA-1" >&2
    exit 1
  fi
  STAMP=$(printf '%.9s' "$VERCEL_GIT_COMMIT_SHA" | tr 'A-F' 'a-f')
else
  # Preserve the non-Git local-build fallback; this is not commit evidence.
  STAMP=$(date +%s)
fi
# Use a temp file for portability (macOS sed -i requires backup suffix)
sed "s/__BUILD_STAMP__/$STAMP/" "$SW_FILE" > "$SW_FILE.tmp" && mv "$SW_FILE.tmp" "$SW_FILE"
echo "Stamped $SW_FILE with build $STAMP"
