# Generated content build contract

**Status:** Implemented 2026-08-01

MD3 compiles database-derived TypeScript modules for the rotation content map
and first-session fast path, plus a sidecar-derived image index. Build intent is
explicit so code verification does not depend on Neon or private media metadata
while anything deployable fails closed.

## Supported entrypoints

| Command | Mode | Database behavior | Intended use |
|---|---|---|---|
| `npm run build` | `offline` | Never imports the script Prisma client or reads `figure-sidecars/` | Local and CI code/type/build verification |
| `npm run build:isolated` | `offline` | Same contract in a temporary checkout | Dirty-worktree-safe code verification |
| `npm run build:release` | `release` | Runs the read-only source-to-serving DB preflight and protected-reinforcement audit, then reads the configured database and aborts on drift, active derived answer cards, read failure, or empty output | Release/deploy builds |
| `npm run build:isolated:release` | `release` | Same strict preflight and release contract in a temporary checkout | Release verification without mutating local generated files |
| `npm run dev` | `database` (legacy default) | Preserves the existing local database-backed generator behavior | Normal local product development |
| Direct generator invocation | `database` (legacy default) | Honors legacy `CONTENT_MAP_STRICT` and `CONTENT_MAP_REQUIRE_DATA` flags | Operator/debug workflows |

Vercel is pinned to `npm run build:release`. The exact-green release helper
also generates both modules in release mode before its tests and calls the
release build explicitly.

## Offline/code-build guarantee

`MD3_GENERATED_CONTENT_MODE=offline` skips the database import entirely and
writes compile-only modules with empty maps/sessions and a fixed generated-at
stamp (`1970-01-01T00:00:00.000Z`). The image-index generator also ignores any
local `figure-sidecars/` tree and writes exactly `{}` plus a newline. Repeating
the generators from the same source checkout is byte-for-byte deterministic.
The output proves that the application compiles; it is not a content release
candidate.

The generated directory remains ignored because these modules are ephemeral
build outputs. Their deterministic offline form is the pinned input for code
verification: checked-in source and schemas, not whatever happens to be in a
developer's database or an old ignored artifact.

## Release guarantee

The supported release entrypoints first pass the repo-native USMLE provenance,
rights, citation, baseline, and item-rubric release gate. They then run the
read-only `usmle:serving-db:preflight`, which compares the eligible source IDs
with the configured serving database. Source-green is insufficient: missing,
retired, or source-drifted serving rows stop the release before any generator
runs. Active answer-bearing reinforcement cards derived from protected Step 1
questions also stop the release, including relationless `qcard:*:fact:*` rows.
Only then do the entrypoints set `MD3_GENERATED_CONTENT_MODE=release`,
which applies the following contract to the database-derived generators and
image index:

1. import the database client and read fresh source rows during this build;
2. abort on connection/query failure, even if old generated files exist;
3. require at least one card/question in the content map;
4. require at least one item across generated starter sessions; and
5. write the generated modules only after those database checks pass.
6. require `figure-sidecars/` to exist and build the image index from that
   checked-in release input; a missing sidecar root aborts the release.

A failed release command is non-zero, so Vercel cannot promote an empty or
fallback artifact. A misspelled build mode is also rejected rather than being
treated as permissive.

On 2026-08-01 the target-labelled configured-database preflight found `0/25`
eligible source questions servable and its protected-reinforcement audit found
zero active candidates. The separately labelled local mirror contained eight
active legacy answer cards. Those are target-specific blockers, not release
claims: passing source audits did not make either selected database ready.

## Limits

- Non-empty is a structural floor, not a semantic content-quality or minimum
  per-rotation guarantee. Content audits and release smoke tests remain
  separate gates.
- The build proves freshness relative to the configured database at generation
  time. The preflight and reinforcement CLI now label `local-mirror` versus
  `configured-database` without printing a URL, but an operator must still
  establish that the configured URL is the intended deployment target.
- The two generators use separate reads, not one cross-generator snapshot.
- An offline `.next` directory is deliberately content-empty. Do not deploy it
  with a prebuilt/manual path that bypasses `vercel.json`.

## Direct mode override

The shared variable accepts exactly `offline`, `database`, or `release`:

```bash
MD3_GENERATED_CONTENT_MODE=offline node --import tsx scripts/content/generate-content-map.ts
MD3_GENERATED_CONTENT_MODE=release node --import tsx scripts/content/generate-starter-sessions.ts
MD3_GENERATED_CONTENT_MODE=offline node --import tsx scripts/images/build-index.ts
MD3_GENERATED_CONTENT_MODE=release node --import tsx scripts/images/build-index.ts
```

Unset mode retains historical direct-script behavior for compatibility.
Setting the mode on a direct generator invocation controls only database
generation; it does not run the public-corpus release gate and is not a deploy
entrypoint.
