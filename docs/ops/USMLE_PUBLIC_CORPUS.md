# Public USMLE corpus operator loop

MD3's public Step 1 corpus is fail-closed. Cross-list membership makes a
question a candidate; it does not establish ownership, an open licence, or
permission to reproduce evidence.

The release corpus lives in:

```text
open-content/usmle/step1/
  sources.json
  baseline-v1.json
  release-v1.json
  questions/<domain>/<slug>.v1.json
```

The private sibling question bank remains a candidate source only. Presence in
that bank does not grant redistribution rights.

Question eligibility and repository distribution are separate gates. Before a
source export, also run `npm run foss:boundary:audit`; the file-level boundary
is documented in `docs/ops/FOSS_DISTRIBUTION.md`.

## Read-only audit

Audit the repo-native release corpus:

```bash
npm run usmle:corpus:audit
```

The default report is written to `/tmp/md3-usmle-corpus-audit.json`. It contains
IDs, source paths, decisions, and stable reason codes only. It deliberately
omits stems, options, answer keys, explanations, raw citations, and annotations.

Useful explicit options:

```bash
npm run usmle:corpus:audit -- --bank-dir <questions-root> --out /tmp/report.json
npm run usmle:corpus:audit -- --bank-dir <questions-root> --sources <registry.json> --baseline <manifest.json>
npm run usmle:corpus:audit -- --json
npm run usmle:corpus:audit -- --release-gate --min-eligible 25
```

A normal audit exits successfully when it finds backlog. Malformed JSON,
invalid schemas, and duplicate IDs fail the command. The explicit release gate
also fails when any audited item is ineligible or the eligible corpus is below
the requested minimum. When baseline validation is enabled, the same minimum
and zero-blocker rule also applies to baseline membership.

The report basis is `source-projection`: bank files are modelled as the state a
clean seed would create (`source=bank`, `contentState=enhanced`) plus tracked
disk exclusions. It is not a statement about live database drift and performs
no database reads or writes.

## Scoped FOSS bootstrap

Validate the repo-native corpus through the exact scoped seed path without
opening Prisma or writing to a database:

```bash
npm run usmle:corpus:seed:dry
```

After the release gate and dry seed pass, load only this open corpus into the
configured database:

```bash
npm run db:seed:usmle-open
```

The live command reruns the exact `--release-gate --min-eligible=25` check
before Prisma is loaded. It never consults the private `question-bank` symlink.
It loads `.env.local` and then `.env` without overriding an explicitly exported
shell variable. It computes the stale set and retirement guard before the first
write, then performs every bulk-upsert batch and stale-row retirement through
one interactive transaction. Any later batch or retirement failure therefore
rolls the whole scoped seed back. Stale rows are eligible only when they were
previously owned by `open-content/usmle/step1/`; the guard refuses a single run
that would retire more than half of the currently live open rows. The command
does not synchronize or mutate private-bank exclusions.

The default registry is `open-content/usmle/step1/sources.json`, adjacent to the
default `questions/` root. Every released item requires a passage pointer and
is cross-checked against that registry for exact source, passage, and licence
agreement. The registry accepts HTTPS URLs only, records a whole-registry
`verifiedAt` date, and fail-closes if its SHA-256 receipt does not match the
dated full registry. A separate quote-set digest makes passage edits directly
auditable. Release and scoped-seed gates reject receipts
older than 90 days or dated in the future. Pass an explicit `--sources` path whenever
`--bank-dir` points at a nonstandard corpus.

The adjacent `baseline-v1.json` and `release-v1.json` files are independent
strict release inputs. The audit rejects malformed manifests, duplicate
memberships, unknown baseline IDs, and any mismatch between the exact release
allowlist and the source corpus. Reports expose totals and eligible/blocker
counts only, never the manifests' IDs or question content. A non-release
candidate scan may use `--no-baseline`; an explicit release gate may not.

`release-v1.json` also binds each member to the canonical source-to-serving
projection with a SHA-256 fingerprint. After an intentional question-content
change, refresh only those derived fingerprints with:

```bash
npm run usmle:release:fingerprints:write
```

This is the sole supported fingerprint writer. It reruns the full source,
rights, provenance, baseline, membership, item-quality, minimum-size, and
source-receipt gates before writing. It preserves `questionIds` exactly and
never edits questions, citations, `sources.json`, or baseline membership.
Replacement uses a same-directory temporary file with a random suffix, file
sync, and atomic rename; an interrupted refresh leaves the prior manifest
intact, and the replacement retains normal source-file mode (`0644`).
Normal audit and release-gate commands remain read-only. Review and commit the
manifest diff beside the intentional source change so the update retains a
normal Git paper trail.

## Read-only serving database preflight

The source gate proves what **may** be seeded. It does not prove what a deployed
server will read. Compare the full checked-in serving projection with the
configured database using:

```bash
npm run usmle:serving-db:preflight
npm run usmle:serving-db:preflight -- --json
npm run usmle:serving-db:preflight -- --out /tmp/usmle-serving-db.json
```

The preflight performs no writes. It fails for missing/unexpected released
rows, drift in any source-authoritative serving field, exclusion/state drift,
or missing Step 1 membership. Its report also records the source-registry
verification date, full-registry digest, and quote-set digest.

The application repeats that protection at runtime. A released ID remains
protected even if its database rotation/module routing drifts. Session delivery
binds the checked-in fingerprint and original answer label into an opaque
server-only capability. Grading locks and rereads the full row, verifies state,
fingerprint, routing, explanation, option set, and answer key, and only then
begins the response/event/stat writes. Drift returns a typed conflict with no
canonical writes, delivery finalization, or background work; explanation is
resolved again from the validated post-grade snapshot before reveal.

On 2026-08-01 the target-labelled configured-database read returned `0/25`
exact rows and zero active protected reinforcement cards. The local-mirror
audit found eight active legacy answer-bearing cards. An earlier draft
incorrectly called that local result “production”; no database mutation was
made. Land the source containment, repair only a selected target that reports
candidates, and complete the re-audit sequence below before adding the public
rows. The remaining bootstrap order is:

```bash
npm run usmle:corpus:release-gate
npm run usmle:corpus:seed:dry
DATABASE_URL_LOCAL= npm run usmle:reinforcement:audit # configured target: currently zero
# With the local mirror selected, audit -> explicit repair:apply -> audit zero.
DATABASE_URL_LOCAL= npm run db:seed:usmle-open
DATABASE_URL_LOCAL= npm run usmle:serving-db:preflight
npm run build:release
```

The corpus seed is the sole corpus-mutating operation; the separately scoped
reinforcement repair below is the only legacy-card mutation. Clearing
`DATABASE_URL_LOCAL` is intentional when the target is the configured remote
database; inspect the environment before running it. Release builds do not seed
for the operator and fail closed until preflight is exact.
The runtime client, read-only preflight, reinforcement audit, seed, and release
content generators all use the same target rule: a non-empty
`DATABASE_URL_LOCAL` selects the local mirror; unset or empty selects
`DATABASE_URL`. Reports expose only `local-mirror` or `configured-database`,
never either connection string.

The release projection also runs the deterministic Step 1 item-writing rubric.
Only `severity: flaw` findings block release; softer calibration warnings remain
authoring feedback rather than hard policy. Reports expose one stable
`item-mechanical-flaw` reason, not stems, answer text, or matched words.

## Derived reinforcement-card containment

A `QuestionReinforcement` card copies a Question answer into `Card.back`.
Released Step 1 questions therefore use only the opaque session/committed-grade
contract; their linked primary cards and legacy relationless
`qcard:<questionId>:fact:<factId>` siblings are not delivery content.

Audit the configured serving database without printing stems, answers, or
contexts:

```bash
npm run usmle:reinforcement:audit
npm run usmle:reinforcement:audit -- --json
```

The default command is read-only and deliberately exits non-zero when any
active candidate exists. `build:release` and `build:isolated:release` run it
after the source/serving projection preflight, so Vercel cannot promote an
otherwise source-green corpus while derived answer cards remain active.

For an existing database with candidates, use this operator sequence against
the intended target:

1. Run `npm run usmle:reinforcement:audit` and retain its ID-only report.
2. Land/deploy the source containment first. If the strict release gate holds
   the promotion because candidates still exist, leave that promotion pending;
   do not bypass the gate.
3. Run `npm run usmle:reinforcement:repair:apply` once. This is the only
   mutating step; it idempotently soft-deletes only the audited active rows.
4. Immediately rerun `npm run usmle:reinforcement:audit` and require
   `0 active candidate(s)` with exit code zero.
5. Retry/complete `npm run build:release` and the normal promotion checks.

Set or clear `DATABASE_URL_LOCAL` deliberately before every command. An empty
`DATABASE_URL_LOCAL` selects the configured `DATABASE_URL`; a non-empty value
selects that local mirror. The repair recognizes canonical `Question.cardId`
links, exact `qcard:<questionId>` IDs, relationless `:fact:` siblings, and
reserved-namespace rows whose `sourceComponent` metadata has drifted. Checked-in
release IDs also protect parents whose routing metadata drifted and orphaned
exact/fact stable IDs whose `Question` row is absent. All release-ID SQL values
are parameters. Never replace the sequence with a broad Card delete.

## Working the lanes

| Lane | Meaning | Action |
|---|---|---|
| `metadata` | Provenance is absent or malformed | Establish origin and rights from evidence; never infer them from filenames or annotations. |
| `restricted-origin` | AnKing, student-deck, Instagram, First Aid, or another uncleared origin | Replace with genuinely original wording or keep private. Never relabel it as authored. |
| `rights` | The question wording or its checked-in evidence passage is not under an accepted open licence | Establish ownership and compatible redistribution rights, or keep it private. |
| `grounding` | An item lacks an exact passage pointer, or its source/passage is absent from the registry | Recover the exact registered source and passage, or regenerate from cleared evidence. |
| `item-quality` | A deterministic item-writing rule found a release-blocking flaw | Rewrite the cue or construction flaw, rerun the rubric, and preserve the evidence pointer. |
| `media` | Media has no typed public provenance | Remove the media or keep the item private until the media contract admits it. |
| `availability` | The item is excluded or unavailable | Rehabilitate deliberately or remove public membership. |
| `out-of-scope` | A release-root item lacks `usmle/step1` membership | Fix the release file's membership or remove it from the release corpus. |
| `eligible` | The canonical public policy passes | Continue through content/mechanical validation and release validation. |

## Provenance example

Every released Step 1 item, including contributor-authored wording, requires
an exact registered passage. Generated wording additionally requires an
approved open evidence licence:

```json
{
  "publicUsmle": {
    "schemaVersion": 1,
    "origin": "generated",
    "itemText": {
      "licence": "CC-BY-4.0",
      "attribution": "MD3 contributors"
    },
    "evidence": {
      "kind": "passage",
      "sourceId": "cdc-pink-book-vaccine-principles",
      "passageId": "passive-immunity",
      "licence": { "cls": "foss", "id": "us-gov" }
    }
  }
}
```

Do not bulk-stamp legacy items. A label such as `foss-grounded-vignette`, a
source-like filename, or an old generation log is not proof of origin, passage,
or licence. Review each item and its source record independently.

Source-authoritative provenance is revocable. If an open-source question file
omits or explicitly nulls its public provenance, the next scoped seed removes
the stale public envelope from the database; it is never preserved merely
because an older seed once established it.
