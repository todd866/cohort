# Feature: FOSS USMLE corpus and vertical slice

**Date:** 2026-08-01  
**Status:** Source complete — internal alpha; deployment and serving bootstrap pending

This document records the implemented design. The checked-in source corpus and
application pass their source-level contract. The configured serving database
contained 0/25 released rows when read-only checked on 2026-08-01; its
protected-card audit was zero, while the separately labelled local mirror had
eight candidates. The strict release build correctly remains blocked until the
selected target is reinforcement-clean and the scoped seed plus post-seed
preflight are run.

## Problem

MD3 has a substantial learning engine and a fail-closed public-USMLE
provenance decision, but the live database currently contains zero questions
with `usmle/step1` cross-list membership. The existing question bank is a
symlink to a private data repository, and the generic study response includes
answer-bearing option metadata before grading. Neither is a sound foundation
for a redistributable public product.

The first product milestone is therefore a small, repo-native, openly licensed
Step 1 corpus plus an administrator-only end-to-end learning loop that is safe
to make public later. It must reuse MD3's core `Question`, `QuestionResponse`,
`LearningEvent`, `ServeDecision`, and content-reporting models.

## Design principles

1. **Open content has a visible source of truth.** Cleared questions and their
   source registry live inside MD3 under `open-content/usmle/step1/`; private
   sibling data is neither required nor implicitly relicensed.
2. **One learning data model.** No USMLE-specific progress, response, card, or
   question tables are introduced.
3. **Fail closed twice.** Disk validation controls what may be seeded; the
   server corpus decision controls what may be served.
4. **Answers stay server-side until grading.** Public session payloads omit
   correctness, explanations, restricted quotations, and private provenance.
5. **The first selector is a bootstrap adapter, not a second scheduler.** It
   chooses only from the cleared corpus using existing response history and
   writes ordinary `ServeDecision` rows. The unified scheduler remains the
   long-term policy engine.
6. **No readiness theatre.** Progress is descriptive until prospective
   calibration succeeds.

## Content layout

```text
open-content/
  README.md
  usmle/step1/
    sources.json
    baseline-v1.json
    release-v1.json
    questions/<domain>/<slug>.v1.json
```

Question files use the existing `CuratedQuestion` schema and carry a
`publicUsmle` envelope. The source registry contains stable source and passage
IDs, title, HTTPS canonical URL, evidence licence, attribution, an exact
redistributable passage quotation, a whole-registry verification date, and a
SHA-256 digests over the dated full registry and the ordered quote set. Original question wording is
CC-BY-4.0.

`baseline-v1.json` pins the learner baseline independently of corpus growth.
`release-v1.json` is a separate exact production allowlist: a newly checked-in
file cannot silently become servable, and a deleted source file cannot remain
on the release list.

The existing private `question-bank` loader remains intact. A new aggregate
seed loader combines the private bank with the open bank, validates duplicate
IDs across roots, and refuses partial/invalid input. The existing private-bank
contract remains private-bank-only so its pinned digest is not conflated with
the public release artifact.

## Provenance and media

The public provenance validator will accept a versioned media envelope:

- `none`: no media is delivered;
- `asset`: stable asset ID, creator/attribution, canonical source URL, licence
  class and exact licence ID.

Image-bearing questions remain ineligible unless every delivered asset has an
allowlisted redistributable licence. Unknown, fair-use, private, or merely
accessible media remains excluded. V1 provenance continues to validate for
text-only items.

## Operator loop

`npm run usmle:corpus:audit` is read-only and defaults to disk mode. It:

1. loads every open question and source entry;
2. applies schema, question-quality, source-reference, provenance, licence,
   attribution, and media checks;
3. reports eligible/rejected totals grouped by stable reason code;
4. emits deterministic JSON with no question stems or answer text by default;
5. exits non-zero for malformed content, duplicate IDs, or a question marked
   release-ready that fails eligibility.

`--json` is the machine-readable source-audit contract for future admin UI and
Cohort consumers. The separate read-only
`npm run usmle:serving-db:preflight` command compares the complete source
projection to the serving database. No audit or preflight mode mutates the
database.

## Internal Step 1 API

The first API remains administrator-only and rate-limited. The layout gate
does not protect APIs, so every endpoint calls `requireAdmin()` itself and
returns `Cache-Control: private, no-store`.

### `GET /api/usmle/step1/session`

Query:

- `mode=baseline|daily`;
- `size=1..20`;
- optional allowlisted `domains`.

Behavior:

1. load the eligible public corpus;
2. load this user's existing `QuestionResponse` history for those IDs;
3. baseline mode prioritises unseen questions across domains;
4. daily mode mixes unseen questions with previously missed/stale questions;
5. shuffle display options server-side;
6. create ordinary delivered `ServeDecision` rows through a strict writer that
   persists the server-only display-to-canonical mapping and fails the request
   if delivery cannot be recorded;
7. return an answer-safe payload.

Response item fields are limited to an opaque delivery ID, stem, display
option label/text, domain, difficulty, question type, and public attribution
summary.
The canonical `Question.id` is also withheld because existing direct-question
routes expose answer-bearing detail. Responses never include `isCorrect`,
original option indices, explanation, private citations, source paths, or
evidence quotations.

### `POST /api/usmle/step1/answer`

Body contains only the opaque delivery ID, selected display label (or skip),
response time, and pre-reveal confidence. The server resolves the hidden item,
session, and display mapping from server-authored delivery metadata, calls the
canonical question-attempt writer, marks the `ServeDecision` answered, and
only then returns correctness, correct answer, explanation, attribution, and
permitted evidence presentation.

The delivery ID is also the canonical idempotency key. An exact replay returns
the same reveal without creating another response/event; a different answer
for a consumed delivery returns `409`. Confidence is written in the same
`QuestionResponse` transaction rather than updated later through the racy
"latest response" endpoint.

### `GET /api/usmle/step1/progress`

Returns descriptive counts only: attempted, correct, baseline remaining,
unseen, recent activity, and domain breakdown. It does not emit a pass
probability, score prediction, or readiness claim.

### Error reports

The UI reuses the existing `ContentIssue` report boundary. Enumerated reasons
can enter triage; optional user prose remains quarantined under the existing
human-firewall contract.

## UI

`/usmle/step1` becomes the internal product home with honest corpus totals and
three actions:

- continue/complete the baseline;
- start today's mixed session;
- inspect coverage and limitations.

`/usmle/step1/study` is a focused client surface for question selection,
submission, reveal, explanation/source display, confidence, error reporting,
and the next-item state. It does not reuse answer-bearing `UnifiedItem`
payloads. Shared visual primitives may be reused, but the transport contract is
the new safe API. The first slice is online-only: existing review caches and
offline packs contain answer-bearing `UnifiedItem` shapes.

## Initial corpus

The implemented internal milestone is 25 original, text-only questions across
six foundational domains. Every item has:

- one learning objective and plausible distractors;
- original wording under CC-BY-4.0;
- a stable source/passage reference with recorded licence and an exact
  checked-in quote;
- concise teaching explanation and per-option rationale where supported;
- deterministic format and public-eligibility checks;
- an exact, machine-checkable citation trail to compatible evidence.

Generated content is releasable when its wording is original, its exact source
and passage resolve through the checked-in registry, its rights are compatible,
and the complete content/quality suite passes. A named human sign-off is not a
release dependency; review history may still be recorded as optional context.

A committed `baseline-v1` membership is pinned independently of the growing
daily corpus. A separate `release-v1` manifest controls production membership.
Together they keep an interrupted baseline comparable and prevent directory
membership from becoming an accidental publication mechanism.

## Technical-debt tranche

The same program established delivery-grounded scheduler attribution, rejected
synthetic concept keys at persistence boundaries, routed answer-side enrichment
through a retry-safe post-commit boundary, and separated deterministic ordinary
builds from fail-closed database-backed release builds. Those changes remain
covered by behavior tests.

The large unified scheduler still needs incremental extraction behind those
tests, and Card↔Concept attribution still needs a reviewed materialized seam
before a schema migration is justified. See the current priorities in
`2026-08-01-usmle-foundation-audit.md`.

## Test cases

1. A malformed, unknown-provenance, private-derived, or unlicensed-media item
   is excluded and produces a stable reason code.
2. Open-bank disk loading works when the private sibling symlink is absent.
3. Duplicate IDs across private and open roots stop seeding.
4. The operator report is deterministic, contains no stem/answer text by
   default, and exits non-zero for release-contract violations.
5. Session responses contain no correctness flags, original indices,
   explanations, private citations, or restricted quotations at any nesting
   depth.
6. A forged serve-decision ID cannot grade an item; an exact consumed-delivery
   replay is allowed while a changed-answer replay returns `409`.
7. A valid answer and its pre-reveal confidence are idempotently persisted through the canonical
   `QuestionResponse`/`LearningEvent` path and reveals the answer only after
   the durable write succeeds.
8. Baseline selection spans domains and excludes previously answered items;
   daily selection prioritises missed/stale plus unseen items without serving
   an ineligible question.
9. Progress counts only eligible corpus IDs and contains no readiness score.
10. User report prose remains quarantined; only bounded reason values cross
    into automated triage.
11. All new UI works at 375 px and 1440 px, is keyboard-operable, and exposes a
    semantic result status.
12. Full app/script typechecks, lint, unit tests, content validators,
    dependency audit, deterministic build, FOSS clean-export build, and strict
    database-backed release build are green for the same source state.

## Release sequence

1. **Done:** ship the operator loop, source registry, explicit release
   manifest, and repo-native 25-question corpus.
2. **Done:** ship the answer-safe internal API and UI behind the administrator
   gate, and contain the same released items from legacy raw transports.
3. **Pending operation:** land the containment source, run the scoped
   idempotent reinforcement-card repair, and require a zero-candidate
   read-only re-audit.
4. **Pending operation:** scoped-seed the intended production database, prove
   the 25/25 read-only preflight, and dogfood the full loop.
5. Expand toward approximately 100 items across every official Step 1 category,
   with more application/interpretation and hard items.
6. Expand toward approximately 200 items, add item-health analytics and
   public/guest abuse gates, and only then call it a public beta.
7. Add typed media only after the text-only and media-rights contracts are
   stable.
8. Extract the stable JSON contracts for Cohort; do not copy the scheduler.

## Non-goals for this tranche

- score prediction or pass/fail claims;
- importing or paraphrasing commercial question banks;
- public image delivery without typed media rights;
- a new USMLE progress schema or scheduler;
- public cards before a separate Card provenance contract exists;
- edits to the Cohort sibling repository before the md3 contract proves out.
