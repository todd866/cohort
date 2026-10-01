# Managing the USMLE product — scope, surfaces, and what not to build

**Status:** Active product boundary; implementation status refreshed 2026-08-01.

**Implementation update (2026-08-01):** MD3 now has a server-only, fail-closed
public-question contract in `src/lib/usmle/public-corpus.ts`. Public membership
comes from `moduleNodes: ['usmle/step1']`, but membership alone is insufficient:
each item also needs explicit versioned text, origin, evidence, and attribution
metadata. A repo-native 25-question baseline across six domains passes the
machine release gate with exact registered source/passage/licence pointers, an
explicit release allowlist, and a dated/hash-bound source receipt. An
answer-safe baseline/daily API and UI are working behind the existing admin
gate, and the same released questions are excluded from legacy raw transports.
The gate controls dogfooding and abuse exposure, not clinical sign-off.
Legacy generated/cross-listed material remains ineligible. Code is MIT, and
cleared original educational content is CC-BY-4.0 under `LICENSE-CONTENT.md`.
The current holistic debt and release roadmap is
`docs/designs/2026-08-01-usmle-foundation-audit.md`.

## The shape of the thing

One corpus, three surfaces, already the established position
([[project_content_split]], [[project_site_structure]]):

| Surface | Audience | Content |
|---|---|---|
| **md3.info** | authenticated private deployments | locally configured curriculum and jurisdiction |
| **future Cohort USMLE surface** | anyone | FOSS-eligible only, openly grounded |
| **md3-open** | self-hosters | the engine, no content |

`/usmle` is a hub, not a fourth app surface. Two doors behind it.

## Routing: how one question serves both

`rotation` is the canonical home and drives scheduling; `moduleNodes` is
hierarchical membership and may span rotations
(`docs/designs/2026-05-09-rotation-vs-modulenodes.md`).

For a dual-use item:

```
rotation:    'local-module'                      ← so a private scheduler can serve it
moduleNodes: ['local-module', 'usmle/step1']     ← so the Step 1 surface aggregates it
```

That ordering matters. The scheduler filters on `rotation` against
`activeModules`, so an item homed at `usmle-step1` would **not** reach a learner
whose active set contains only local modules. Home it locally and cross-list it. The public
surface queries `moduleNodes` overlap, which is exactly what `moduleNodes` exists
for.

**Do not add a vertical-specific Prisma model.** CLAUDE.md's data-model rule:
new verticals use the core `Card`/`Question` tables with a `rotation`.

## The two jurisdictions problem — the one real design tension

Step 1 is US: conventional units (mg/dL), US drug names (epinephrine,
acetaminophen). Australian curricula commonly use SI units (mmol/L) and INN names (adrenaline,
paracetamol). **One string cannot be idiomatic for both.**

Current answer: SI first with conventional units in parentheses, reference ranges
inline — "urine protein:creatinine 62 mg/mmol (548 mg/g; normal <30 mg/mmol)".
Verbose but correct in both, and it is what international editions do.

That is a compromise, not a solution. If the Step 1 surface ever gets real users,
the honest fix is a **presentation-layer unit/nomenclature transform** keyed off
the viewing surface, with the item stored once in SI. Do not fork the content —
that is how two divergent banks and a permanent reconciliation cost get created.

## What is built, and what the numbers actually are

- **25 public questions** in a pinned baseline across immunology, microbiology,
  endocrine, renal, hematology, and genetics.
- **14 official-government source records and 25 stable passage pointers** in
  the checked-in registry; citations are resolved from that registry after
  grading. The receipt records verification date `2026-08-01` and a digest over
  the exact quote set.
- **A deterministic release gate** covering provenance, source/passage/licence
  agreement, text-only media policy, baseline membership, exact release
  membership, answer-key distribution, and mechanical item flaws.
- **An answer-safe learning loop**: opaque delivery, atomic answer + confidence,
  explanation and citation reveal, descriptive progress, and issue reporting.
- **37 private cross-listed legacy candidates**, currently 0 eligible because
  none has the explicit public provenance contract. They are backlog, not a bank.
- **A read-only serving drift gate**, currently reporting **0/25** exact rows in
  the configured serving database. Source code is green; bootstrap is still
  pending and strict release builds fail closed until it is 25/25.
- **A target-labelled protected-card gate**: the configured database currently
  reports **zero** active candidates, while the local mirror reports **eight**
  answer-bearing legacy reinforcement cards. Source containment is complete;
  deployment and the local mirror's scoped repair/re-audit remain.
- Legacy Step 1 cards, reference corpora, and metrics-only commercial samples
  remain private research inputs and are not public-product coverage.

The current corpus is intentionally labelled an internal alpha: 16 items are
easy, nine medium, none hard; 14 are mechanism questions; and it has no image,
audio, or chart/table items. It does not cover cardiovascular,
neuro/behavioural, musculoskeletal/skin, respiratory, gastrointestinal,
reproductive, multisystem, population-health, communication, or
human-development categories adequately. These composition gaps, rather than
more infrastructure, are the next product bottleneck.

## Sequencing — cheapest real value first

1. **Contain, repair, then bootstrap and dogfood the 25-item loop** while
   preserving the opaque delivery and post-grade citation contracts. Production
   is not ready until the source containment lands, the scoped legacy-card
   repair re-audits at zero, and the scoped seed is followed by a 25/25 drift
   preflight.
2. **Author toward ~100 blueprint-spanning items** with a majority of
   application/interpretation items and explicit hard-item coverage.
3. **Author toward ~200 items before calling it a public beta**, gating every
   one and using response/report data to find weak items.
4. **Add public onboarding and abuse controls** before removing the admin gate;
   do not mistake authentication state for content assurance.
5. **Hints as a graded third outcome.** Cheap, and the best idea observed in a
   commercial product: they report "correct", "correct using hints" and
   "incorrect" separately. We collapse to binary. It also feeds
   [[project_familiarity_gauge]] better than speed alone.
6. **Surface the peer answer distribution only after cohorts are large enough.** `facilityIndex`,
   `discriminationIndex` and `combinations` are already stored — this is a display
   change.
7. **Let Cohort consume the proven JSON contracts and UI primitives**; do not
   fork the scheduler, question model, or provenance policy.

## What NOT to build

- **A score predictor.** md3's predicted-recall estimator is
  `quarantined-failing` — Brier 0.668, AUC 0.507 (chance), ECE 0.739. A predicted
  score on that basis is a confident number with nothing behind it. Fix
  calibration first; morning-check 12f is the gate.
- **A commercial item bank, imported.** cohort.md's entire claim is that every
  item is openly grounded and traceable. One imported stem voids that for the
  whole corpus. Licensed items may be *scored* for calibration with metrics-only
  persistence; that is the line.
- **Step 2 content, yet.** `/step2` is a placeholder until Step 1 has a real bank.
  Note its target stem is ~170w, not 103w — measured.
- **A second parser for the 2021-08 Step 2 CK layout**, until Step 2 is real. It
  would roughly double that reference set; it is not on the critical path.

## The corpus problem this exposed

Retrieval for Step 1 *mechanism* claims is weak. Grounding "CFTR dysfunction
impairs chloride secretion" returned a **bronchiolitis** guideline; ductus
arteriosus returned *intrapartum fetal surveillance*. LocalEvidence grew
demand-driven from clinical questions, so it is guideline-rich and basic-science-poor
— the same domain mismatch found with the pedagogy layer, where the NBME guide
ranked below a post-stroke swallowing paper.

Two consequences:

- Step 1 authoring cannot be **score-gated** on grounding yet; it must be
  retrieve-then-read, and the generator's `skip` rate is the honest measure of
  corpus fitness. On the first run that rate was **0 of 12**, which given the
  retrieval quality means the generator was leaning on its own knowledge more than
  on the passages. Treat that as a finding to fix in the prompt, not a success.
- The flywheel target for a Step 1 push is **basic-science reviews** —
  physiology, biochemistry, embryology, pharmacology mechanism — not more clinical
  guidelines.
