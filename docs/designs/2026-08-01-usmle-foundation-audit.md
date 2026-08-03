# MD3 / USMLE foundation audit

**Date:** 2026-08-01  
**Status:** Active product and release baseline

## Executive verdict

MD3 now has a real FOSS USMLE foundation: a checked-in 25-question Step 1
corpus, exact source/passage receipts, deterministic release manifests, an
answer-safe learning loop, descriptive progress, and a fail-closed production
drift check. It is an **internal alpha**, not yet a credible exam-preparation
bank. The product loop exists; breadth, item depth, psychometrics, and production
bootstrap are the remaining product work.

The strategy is settled:

- MD3 is the implementation and learning-engine source of truth.
- MedKit is dead and remains historical only.
- MD3 code is MIT; contributor-owned educational content is CC BY 4.0.
- Cohort should later consume the proven transport, provenance, and export
  contracts. It should not fork the scheduler or question model.
- Release decisions are machine-verifiable. A named human sign-off is not a
  gate; citations, hashes, manifests, tests, and observable learning data are.

## Exact state on 2026-08-01

| Layer | State | Evidence |
|---|---|---|
| Open source corpus | **25/25 source-eligible** | `open-content/usmle/step1/questions/` and `npm run usmle:corpus:release-gate` |
| Release membership | **Pinned exactly** | `baseline-v1.json` and the independent `release-v1.json` allowlist must both match the source set |
| Evidence registry | **14 official source records, 25 exact passages** | `sources.json`, rechecked `2026-08-01`; full-registry SHA-256 `23e56cafc9ea5658a0cced162220f5364806545f35930a88c827aab603616d16`; quote-set SHA-256 `4d310b8edd62e6bf6223c634e04e20c5253347d2e3f17600d55a3c6f7035b6ad` |
| Medical-content adjudication | **25/25 independently checked against exact passages** | Initial tally: 20 pass, 4 minor, 1 major teaching defect, 0 critical; all five actionable repairs applied, with no miskey or one-best-answer failure found |
| Delivery | **Implemented behind admin auth** | Opaque delivery IDs, server-side option mapping, no pre-grade answer or topic leakage |
| Answer write | **Implemented and idempotent** | Confidence and answer are committed atomically; reveal occurs only after the durable write |
| Progress | **Descriptive only** | Attempt/correct/unseen/domain counts; no score or pass prediction |
| Legacy isolation | **Fail-closed in source** | Generic question/card, derived reinforcement, sync, mobile, session, candidate, and review paths exclude released Step 1 items; deployment is still pending |
| Repository distribution | **Deterministic subset** | Whole repo remains private because it tracks uncleared legacy content; `npm run foss:export` emits only the reviewed FOSS boundary |
| Configured database | **Not bootstrapped: 0/25; 0 active protected reinforcement cards** | Target-labelled read-only checks with `DATABASE_URL_LOCAL=` on 2026-08-01 |
| Local mirror | **0/25; 8 active protected reinforcement cards** | Target-labelled read-only checks using the configured non-empty `DATABASE_URL_LOCAL` on 2026-08-01 |
| Release build | **Intentionally blocked** | `build:release` requires source-gate success, an exact source-to-serving-DB match, and zero active protected reinforcement cards |

No deployment, database repair, or database seed is implied by this document.
The local mirror needs the contained eight-row repair before local dogfooding.
The configured database needs no reinforcement repair at this snapshot, but it
still needs the scoped 25-row bootstrap before the product can serve the public
corpus.

## What was fixed

### Open-content and rights boundary

- Added a repo-native source tree that does not depend on the private
  `question-bank` symlink.
- Added MIT software and CC BY 4.0 contributor-content grants, contribution
  terms, third-party notices, and a deterministic distribution policy.
- Kept imported decks, First Aid/textbook/question-bank material, social-media
  content, unknown provenance, and uncleared media outside the FOSS export.
- Required every released question—authored or generated—to resolve to an exact
  checked-in evidence passage. Public accessibility alone never establishes
  redistribution rights.
- Made source-authoritative provenance revocable: removing the source envelope
  removes the database's public eligibility rather than preserving stale trust.

CC BY 4.0 permits sharing and adaptation, including commercial reuse, subject
to attribution, a licence link, change indication, and no additional
restrictions ([Creative Commons licence summary](https://creativecommons.org/licenses/by/4.0/)).
Government-source reuse remains per-source and fail-closed: CDC identifies
third-party exceptions and requires attribution, non-endorsement, fidelity, and
update checks ([CDC agency-material policy](https://www.cdc.gov/other/agencymaterials.html));
NIH likewise identifies third-party/image exceptions and recommends linking and
periodic rechecking ([NIH copyright FAQ](https://www.nih.gov/about-nih/frequently-asked-questions#copyright));
FDA recommends source links, copy dates, and monitoring for updates
([FDA website policy](https://www.fda.gov/about-fda/about-website/website-policies));
and MedlinePlus explicitly distinguishes public-domain medical-test information
from licensed content ([MedlinePlus reuse policy](https://medlineplus.gov/about/using/usingcontent/)).

### Release paper trail

The release boundary now has four independent receipts:

1. `sources.json` records canonical HTTPS sources, per-passage locators and
   quotes, licence URLs, attribution, a verification date, a full-registry
   digest, and an independent digest over the ordered quote set.
2. `baseline-v1.json` pins the learner baseline independently of corpus growth.
3. `release-v1.json` is the explicit production allowlist and binds every ID to
   the SHA-256 of its exact source-to-serving projection. Adding a source file
   cannot silently publish it, deleting one cannot leave a stale released row,
   and a content edit requires the explicit, full-gated, atomic
   `usmle:release:fingerprints:write` receipt update.
4. `usmle:serving-db:preflight` compares the complete serving projection of
   every released source item with the read-only database state. Missing,
   unexpected, content-drifted, excluded, or misclassified rows fail the build.

The source projection and seed use the same mapper, preventing the preflight
from blessing a representation different from the one the seed writes. The
scoped seed runs the exact release gate before Prisma is opened.

### Answer-safe product loop

The Step 1 surface uses a dedicated transport instead of the legacy
answer-bearing `UnifiedItem` shape:

```text
checked-in release allowlist
  -> server-only eligibility check
  -> opaque ServeDecision + shuffled display labels
  -> answer-safe session payload
  -> atomic QuestionResponse + LearningEvent
  -> post-commit explanation + permitted citation reveal
```

Released Step 1 questions and answer-bearing reinforcement cards derived from
them are rejected by generic/raw transports. Static released IDs remain the
authority even if mutable rotation/module routing drifts. Generic review
writers reject the questions unless the dedicated answer route supplies its
module-private capability and source-bound fingerprint, routing, explanation,
and answer label. The protected writer precomputes the immutable event outside
the transaction, locks and rereads the complete row, and performs the first
canonical write only after every binding matches. Drift causes zero response,
event, stats, delivery-finalization, or background writes. The reveal uses the
validated post-grade snapshot rather than the write receipt. This is
fair-assessment containment, not DRM: the question source and answer key are
intentionally available in the FOSS tree.

#### Derived-Card egress inventory

`QuestionReinforcement` copies the keyed option into `Card.back`. Its
deterministic `qcard:<questionId>` namespace also includes historical
relationless `qcard:<questionId>:fact:<factId>` siblings, so the global Prisma
relation/marker predicate is defense in depth rather than a complete boundary.
Every answer-bearing transport re-resolves that stable-ID parent through
`src/lib/usmle/reinforcement-card-delivery.ts`; reserved `qcard:` rows with a
drifted `sourceComponent` and malformed/orphan lineage fail closed.

| Egress class | Complete source inventory | Containment |
|---|---|---|
| Direct APIs | `src/app/api/cards/[id]/context/route.ts`; `content-quality/flagged/route.ts`; `content/flag/route.ts`; `cron/embedding-batch/route.ts`; `deck/flag/route.ts`; `exams/[slug]/high-yield/route.ts`; `knowledge/facts/route.ts`; `learn/route.ts`; `mobile/content-pack/route.ts`; `sandbox/session/route.ts`; `smp/cards/route.ts`; `study/exam-readiness/route.ts`; `sync/content/cards/route.ts` | Each invokes the asynchronous lineage resolver before response serialization, snapshot persistence, or model-provider submission. |
| Direct pages | `src/app/cards/[id]/page.tsx`; `src/app/f/[id]/page.tsx` | The requested card and every related/preview list are filtered before rendering; rejected singletons become not-found or omit the preview. |
| Unified session APIs | `src/app/api/study/unified-session/route.ts`; `src/app/api/integrations/paperscope/review/session/route.ts`; `src/app/api/study/offline-pack/route.ts` | Both live session routes share `unified-session-service`; offline fill shares `computeAndHydrateSession`. All terminate in a contained lane/hydration path. |
| Session lanes | `unified-session-hydration.ts`; `unified-session-instant.ts`; `unified-session-starter.ts`; `unified-session-cache.ts`; `unified-session-rereview.ts`; `unified-session-review-filter.ts`; `unified-session-manifold.ts`; `unified-session-cache-compute.ts` under `src/lib/study/` | Static, fallback-DB, rereview, warm-cache, starter, instant, and manifold candidates are resolved before decisions/exposure logging and response. A rejected warm cache is invalidated. |
| Durable queues/caches | `src/lib/study-queue.ts`; `src/lib/offline/pack.ts` | Queue insertion re-resolves new and already-stored card IDs and scrubs stale JSON. Offline schema v6 purges pre-containment packs containing Questions or `QuestionReinforcement` payloads; new packs come only through contained hydration. |
| Generated/public artifacts | `scripts/content/generate-content-map.ts`; `generate-starter-sessions.ts` | Each filters current DB rows through the resolver before writing answer-bearing TypeScript. The legacy static-queue generator and its four answer-bearing `public/static-queues/*.json` outputs were removed after a live-read audit proved they were directly downloadable; a regression test now rejects raw answer flags in any public JSON. Release generation remains database-backed and fail-closed. |
| Direct public resources | `public/` recurrence gate | Removed the live, unauthenticated answered university case-study guide from `public/resources`; the regression gate pins that path absent. Third-party media remains governed separately by the figure attribution and delivery controls. |
| Legacy practice grading | `/api/questions/respond` | The historical transport returned raw `isCorrect` flags on anonymous `GET` and allowed anonymous arbitrary-ID grading on `POST`. Both methods now pass an administrator gate before body parsing or database access and every outcome is private/no-store. The dedicated Step 1 delivery-receipt flow is the intended product path. |
| Secondary/external consumers | `src/lib/content-gen/liked-variants.ts`; `src/lib/manifold/exam-relevance.ts`; `src/lib/manifold/sparse-regions.ts`; `src/lib/manifold/inference.ts`; `src/lib/content-issue-validation.ts` | LLM/embedding submissions, admin diagnostics, knowledge-gap output, and resolution snapshots cannot consume rejected cards. Unused `front` selections in leech/remediation/audit paths were removed. |

`src/lib/usmle/reinforcement-card-egress-contract.test.ts` discovers every App
Router/page selector for `front`, `back`, `backs`, or Card `context`, requires
the resolver, and pins every indirect path above. Creation is separately
blocked and retires exact primary/fact IDs in
`src/lib/review/question-reinforcement.ts`; the DB repair/audit is
`scripts/usmle/repair-protected-reinforcement-cards.ts`.

The first read-only audit on 2026-08-01 found eight active legacy primary cards
on the **local mirror**. A target-labelled recheck with
`DATABASE_URL_LOCAL=` found zero active candidates on the configured database;
a separate aggregate read found six already-retired historical rows there,
last retired before this work began. No database mutation was made. The earlier
draft description of the eight rows as “production” was wrong and is retained
here as a corrected audit trail, not silently propagated. Operator output now
labels `local-mirror` versus `configured-database` without printing a URL.
Strict release builds fail whenever the selected target has a non-zero active
count; the required dry-run, explicit apply, and zero-candidate re-audit
sequence is recorded in `docs/ops/USMLE_PUBLIC_CORPUS.md`.

### Medical-content adjudication

Every released item was separately read against its registered exact passage.
The initial result was 20 pass, four minor item-writing repairs, one major
teaching-language repair, and zero critical defects. No keyed answer was found
to be wrong or materially unsupported, and no item lost its one-best-answer
structure after repair.

The major repair removed an overbroad claim that a child's nephrotic proteinuria
requires “inflamed glomeruli,” made the mechanism and distractors parallel, and
replaced the adult source excerpt with the child-specific NIDDK description of
damaged glomeruli permitting protein leakage
([NIDDK nephrotic syndrome in children](https://www.niddk.nih.gov/health-information/kidney-disease/children/nephrotic-syndrome-children)).
The minor repairs corrected hepatitis B symptom timing and used real serologic
distractors
([CDC clinical signs of hepatitis B](https://www.cdc.gov/hepatitis-b/hcp/clinical-signs/index.html)),
made sickle-cell distractors clinically adjacent, removed an answer cue from
the live-vaccine item, and replaced absolute mitochondrial wording. The
glucocorticoid-withdrawal item also now uses the current
“glucocorticoid-induced (tertiary) adrenal insufficiency” terminology
([Endocrine Society/ESE guideline](https://www.endocrine.org/journals/jcem/glucocorticoid-induced-adrenal-insufficiency)).

The changed NIDDK quotation and metadata intentionally produced the new
registry and quote-set SHA-256 receipts recorded above. This adjudication is a
documented evidence check, not a named-person release gate.

### Platform debt reduced as part of the tranche

- Delivery attribution now survives through `ServeDecision` into review
  outcomes instead of depending on sparse `Card.conceptId` data.
- Synthetic scheduler-only concept keys are rejected at persistence boundaries.
- Local and remote Prisma clients share soft-delete/query-count extensions.
- Content-quality exclusion refreshes retain the last known safe snapshot on
  transient failure.
- Post-commit enrichment has an explicit retry-safe boundary instead of naked
  request-path promises.
- The enumerable legacy database-citation endpoint is admin-only, returns a
  uniform no-store 404 before any database read for non-admin callers, and is
  absent from the public artifact. Step 1 citations use only the checked-in
  open registry.
- Every identified legacy answer-bearing session, direct lookup, grading,
  external-integration, model-chat, card-enrichment, video, and figure-delivery
  API now crosses one administrator gate before request parsing, database or
  filesystem access, signing, model calls, or writes. Every outcome is private
  and no-store. The old root and all legacy course/review/detail page families
  are gated at an ancestor layout before rendering.
- The five abandoned MedKit/native endpoints are uniform 410 responses with no
  authentication, email, content, or database imports. The one-year mobile
  bearer helper was removed, and PaperScope now accepts only its separately
  configured integration token.
- Direct app-origin `/figures/*` delivery is rewritten before static-file
  resolution to a uniform no-store 404, and public R2 hosts are no longer
  allowlisted by Next Image or the app CSP. The historical `r2.dev` bucket is
  still independently internet-readable until the code quarantine is deployed
  and the bucket's Public Development URL is then disabled; that ordered
  infrastructure debt is recorded in
  [`docs/ops/LEGACY_MEDIA_QUARANTINE.md`](../ops/LEGACY_MEDIA_QUARANTINE.md).
- Canonical md3.info/cohort.md email and callback origins require an explicit
  deployment trust flag; self-hosted forks trust only their configured HTTPS
  origin, and outbound email has no default credential or sender identity.
- Ordinary builds generate deterministic offline artifacts; strict release
  builds require current database-backed artifacts.
- Framework, ORM, auth, sanitization, imaging, and transitive dependency fixes
  leave the dependency audit clean at this baseline.

## The product gap, measured honestly

The current 25 items are useful for exercising the system, not for estimating
Step 1 readiness.

### Corpus shape

| Dimension | Current distribution |
|---|---|
| Domains | microbiology 8; endocrine 7; immunology 5; renal 2; genetics 2; hematology 1 |
| Item purpose | mechanism 14; interpretation 8; management 1; diagnosis 1; calculation 1 |
| Difficulty | easy 16; medium 9; hard 0 |
| Media/format | text only; no image, gross/micro specimen, table/chart, or audio item |
| Key balance | A 8; B 4; C 4; D 4; E 5; maximum share 32%; longest same-key run 3 |

The official Step 1 specification is broader: it spans 11 weighted system/social
categories, assigns 60–70% to applying foundational science and 20–25% to
diagnosis, and says the majority of questions require interpretation or
application ([USMLE Step 1 content specification](https://www.usmle.org/exam-resources/step-1-materials/step-1-content-outline-and-specifications)).
The official format is a patient-centred one-best-answer vignette with four or
more options and includes graphic, pictorial, and audio material
([USMLE Step 1 formats](https://www.usmle.org/exam-resources/step-1-materials/step-1-test-question-formats)).
Since 14 May 2026 the test uses fourteen 30-minute blocks, up to 280 items, in
an eight-hour session ([USMLE exam resources](https://www.usmle.org/exam-resources)).

Against that target, MD3 is missing meaningful cardiovascular,
neuro/behavioural/special-senses, musculoskeletal/skin, respiratory,
gastrointestinal, reproductive, multisystem, biostatistics/population health,
communication, and human-development coverage. Its current domain labels are
not yet a complete blueprint taxonomy, so the counts above must not be marketed
as blueprint coverage.

## Remaining debt and priority

| Priority | Debt | Required move | Exit evidence |
|---|---|---|---|
| P0 | Source containment is not deployed; the live legacy deployment can still serve files/routes removed or gated here | Deploy this exact source, purge/age out old caches, and probe every known legacy path before any corpus seed | Known static-answer/resource/API/page probes are 404/410 or admin-denied; dedicated Step 1 flow remains green |
| P0 | Local mirror has eight active legacy reinforcement cards that copy protected Step 1 answers | Land the source containment, run the scoped idempotent repair against that explicitly labelled target, and immediately re-audit | Local-mirror read-only audit reports zero active candidates; no broad Card mutation |
| P0 | Configured serving DB is 0/25 | Run the scoped open seed against the intended target, then the target-labelled read-only preflight | 25/25 exact source rows and serving projection |
| P0 | Corpus breadth is far below exam scope | Add blueprint taxonomy and author across every missing official category | Coverage report shows all official categories; no category is silently collapsed |
| P0 | Items skew easy and first-order | Add longer integrative vignettes, diagnosis, calculations, charts/tables, and harder application items | Versioned item-format/difficulty distribution meets published alpha targets |
| P1 | No defensible readiness model | Instrument facility, discrimination, response time, confidence/hints, repeat performance, and report rate; calibrate prospectively | Published calibration set and error metrics before any score/pass claim |
| P1 | Session creation is a side-effecting, non-idempotent `GET`; unanswered deliveries do not expire | Move creation to an idempotent `POST`, replay the original batch by caller key, and enforce a bounded answer window | Retry/concurrency tests show one batch and stale-delivery tests show zero writes |
| P1 | Citation revalidation is still manual | The gate now expires receipts after 90 days; automate HTTPS/passage/licence checks while keeping quote changes intentional | Dated, digest-matched green receipt in each release with no expired window |
| P1 | Historical third-party media is still reachable through an external `r2.dev` development URL | After deploying the app quarantine, verify private signed delivery for retained cleared assets and disable the Public Development URL | Known external object no longer returns success; source/build scans contain no public hostname; attribution and FOSS gates pass |
| P1 | The unified scheduler remains a hotspot | Continue extracting attribution, signal loading, concept prioritisation, and lane assembly behind regression tests | Smaller modules with zero scheduler-behaviour diff |
| P1 | Card↔Concept attribution remains mostly implicit | Add a reviewed mapping/materialized seam using delivery attribution; avoid a premature migration | Deterministic attribution coverage report |
| P1 | Script/command surface remains large | Keep the generated tooling contract, standardise executors, and archive only proven orphans | CI-enforced supported-entrypoint inventory |
| P2 | Public media provenance is not implemented | Add typed asset rights, attribution, hashes, and per-asset release checks before shipping media | Every delivered asset resolves through a compatible media receipt |
| P2 | US/AU presentation is mixed | Store one factual item and add surface-specific unit/drug-name transforms | Snapshot tests for both presentations; no forked question text |
| P2 | Public access needs abuse/onboarding controls | Add guest limits, privacy-preserving onboarding, and accessible recovery states before removing admin auth | Public threat/UX tests and published limitations |

## Path forward

### Milestone 0 — bootstrap and dogfood (now)

1. Run `npm run usmle:corpus:release-gate` and
   `npm run usmle:corpus:seed:dry`.
2. Deploy the source containment, verify the known legacy paths fail closed,
   then complete the ordered external-media shutdown in
   `docs/ops/LEGACY_MEDIA_QUARANTINE.md`.
3. Run the target-labelled read-only
   reinforcement audit. Apply the scoped idempotent repair only to a target
   that actually reports candidates, then require a zero-candidate re-audit.
4. Run `DATABASE_URL_LOCAL= npm run db:seed:usmle-open` against the intended
   production database. This is the only corpus-mutating step and is
   deliberately not performed by a build.
5. Run `DATABASE_URL_LOCAL= npm run usmle:serving-db:preflight` and require
   25/25.
6. Dogfood baseline, daily, retry, report, mobile-width, and keyboard flows.

### Milestone 1 — approximately 100 items

- Introduce an explicit official-blueprint mapping.
- Fill every currently absent category before deepening the six existing ones.
- Target a majority of application/interpretation items, add hard items, and
  begin with rights-simple text and generated tables/charts.
- Publish the corpus composition report with every release.

This is the point at which MD3 becomes a useful **foundational practice
product**, though still not a comprehensive bank.

### Milestone 2 — approximately 200 items and public beta

- Add public onboarding and abuse controls.
- Add item-health dashboards and automatic quarantine thresholds for broken,
  miskeyed, overexposed, or highly reported items.
- Publish facility/discrimination/report-rate limitations. Do not display a
  score predictor.
- Add typed media only after the media rights contract is release-tested.

### Milestone 3 — Cohort spillover

Extract and consume the versioned `step1-contract`, provenance policy, source
registry, deterministic export, and reusable UI primitives in Cohort. MD3 owns
the learning behavior until a genuinely reusable package boundary is proven.
The same contributor-owned content remains CC BY 4.0 in both products.

## Release definition

A release is green only when all of the following are true:

- source corpus gate has zero blockers and exact baseline/release membership;
- source registry has a current dated receipt and matching full-registry and quote-set digests;
- serving DB preflight is an exact match;
- protected-reinforcement audit reports zero active candidates;
- no generic API, page, pack, session, sync, candidate, or review path exposes
  released answer keys before the dedicated grade boundary;
- all response/event writes remain atomic and idempotent under retry;
- FOSS boundary audit and clean export build pass without private roots;
- app/script typechecks, lint, unit/integration tests, dependency audit,
  deterministic build, and strict release build pass;
- public copy states the actual corpus size, coverage, and limitations.

The durable advantage is not content lock-in. It is the combination of open
content, inspectable rights provenance, strong teaching, trustworthy
measurement, and a learning loop people return to.
