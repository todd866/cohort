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

STAMP=$(git rev-parse --short HEAD 2>/dev/null || date +%s)
# Use a temp file for portability (macOS sed -i requires backup suffix)
sed "s/__BUILD_STAMP__/$STAMP/" "$SW_FILE" > "$SW_FILE.tmp" && mv "$SW_FILE.tmp" "$SW_FILE"
echo "Stamped $SW_FILE with build $STAMP"
