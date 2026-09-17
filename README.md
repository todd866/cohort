# Cohort

Open-source spaced repetition for medicine, scheduled over an embedding of
concepts rather than a deck of facts.

Try it at **[cohort.md](https://cohort.md)**. No account is needed to study.

Cohort is a learning engine with an open question bank aligned to the USMLE
curriculum: 556 questions so far, each written for this corpus and carrying the
source passage behind it. The bank is early and grows every release. Code and
content are both open, MIT software and CC BY 4.0 content, and the export that
produces this repository fails closed, so nothing reaches it without
machine-checkable rights.

## How it works

Every card, question and concept in the engine becomes a 3,072-dimensional
vector, so scheduling happens over concepts and their neighbourhoods instead of
over isolated facts: the scheduler measures the distance between what a learner
has shown they know and what an exam expects, and serves what lies between.
Cosine scoring runs inside Postgres, so the vectors stay in the database. That
engine is in this repository, under `src/lib/manifold/` and
`src/lib/knowledge/unified-scheduler.ts`, and it is what runs md3.info.

The public Step 1 reviewer does not use that concept-space scheduler yet; the
surfaces are being moved onto it one at a time. Today the reviewer ranks on
your answer history, the question's difficulty and the teaching ladders in the
corpus, and is small enough to read in one sitting. Questions sit on three tiers. Two correct
answers at a tier move you up; a single miss moves you down at once, and the questions that
follow are drawn from the same ladder — the rungs that build toward the concept
you just missed — before widening to its domain. The asymmetry is deliberate:
nobody should have to fail twice before being helped.

Progress is reported as what you have seen, what you got right, and how the
ladder moved. There is no predicted score, and the product says so.

Rights metadata, citations and content hashes travel with every item, and the
release gate rejects anything missing them. Design notes and the measurements
behind them are at [cohort.md/tech](https://cohort.md/tech).

## The open corpus

| | |
|---|---|
| Step 1 questions | 556 original, citation-backed items, each with a source and passage pointer |
| Baseline set | 25 original items served as the fixed first exposure |
| Diagrams | 55 original, CC BY 4.0, drawn for this corpus |
| Recorded ECGs | 5 de-identified: four PTB-XL (CC BY 4.0), one VTaC (CC BY-SA 4.0) |

All of it is in this repository. The questions are plain JSON under
`open-content/usmle/step1/questions/`, each with its provenance envelope, and
the diagrams and ECGs sit beside them in `open-content/usmle/step1/media/`,
reusable under CC BY 4.0 without running the app. Blueprint coverage is
incomplete. The questions are written for this corpus rather than recalled from
exams; see the trademark note below.

## Quick start

You need Node.js 24 and PostgreSQL.

```bash
npm ci
cp .env.example .env.local
# Set DATABASE_URL and NEXTAUTH_SECRET.
# /usmle is a public early product: guests and signed-in users can study.
# To enable sign-in, configure at least one provider:
#   GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET, GITHUB_ID + GITHUB_SECRET,
#   or RESEND_API_KEY + EMAIL_FROM.
npm run db:push
npm run db:seed:usmle-open
npm run usmle:figures:install   # copy the 60 open visual assets into public/
npm run dev
```

`usmle:figures:install` copies the openly licensed assets from
`open-content/usmle/step1/media/` to `public/figures/usmle/step1/`, where the
questions expect them. Run it before `dev` or `build`; it is idempotent and only
copies assets that pass the open-corpus name check.

To check a clean checkout:

```bash
npm run foss:boundary:audit      # nothing private crossed the boundary
npm run foss:test                # the public test surface
npm run usmle:corpus:release-gate
npm run usmle:corpus:seed:dry
npm run build
```

## What is in here

- `src/lib/manifold/` — the embedding space and the in-database cosine scoring.
- `src/lib/knowledge/unified-scheduler.ts` — the concept-space scheduler
  described above. md3.info runs it; the public Step 1 surface is not wired to
  it yet.
- `src/lib/exam-target/` — points that scheduler at a blueprint. It ships with
  an **empty registry**: the private instance targets one university's exam
  domains and weightings, which are that institution's material. Register your
  own target in `registry-data.ts`.
- `src/lib/usmle/step1-adaptive.ts` — the public reviewer's tiers, promotion
  streak and ladder scaffolding. Pure and dependency-free, so the rule is
  testable without a database or a session.
- `open-content/usmle/step1/` — the corpus, its baseline, its media and the
  source registry, with a release fingerprint the seed checks against.

## Cohort and md3

The same engine runs [md3.info](https://md3.info), the author's own deployment,
which carries a much larger question bank and course content. That instance is
sign-in only: most of its material is written from licensed textbooks and
university teaching, which cannot be redistributed. Ask if you would like an
account to see the engine at that scale. Cohort stays open, content included.

## Running it for other people

Because both hosts share one engine, an `AUTH_TRUST_MD3_COHORT_HOSTS` flag
exists. For a fork, leave it false and set your own HTTPS `AUTH_URL`. For the
canonical dual-host deployment, set `AUTH_TRUST_MD3_COHORT_HOSTS=true`, leave AUTH_URL and NEXTAUTH_URL unset,
and register both `https://md3.info/api/auth/callback/google` and
`https://cohort.md/api/auth/callback/google` (and the GitHub equivalents).

`/privacy` and `/terms` ship operator-neutral. If you host Cohort for learners,
write your own before you onboard anyone.

## Contributing

Code, accessibility, tests, documentation, source-registry entries and original
questions are all welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: it
explains the rights boundary, the provenance envelope every question needs, and
why "publicly accessible" does not mean "free to redistribute".

## Licence and provenance

Software: MIT (`LICENSE`). Original educational content: CC BY 4.0
(`LICENSE-CONTENT.md`). Third-party material keeps its own terms, recorded
beside it; citing a page does not relicense it.

This repository is generated by `npm run foss:export` from a private source
tree. Only explicitly selected files and rights-verified items enter an export,
each hashed in `FOSS-DISTRIBUTION-MANIFEST.json`. Learner data never enters this
repository.

## Trademark

USMLE® is a registered trademark of the Federation of State Medical Boards and
the National Board of Medical Examiners. Cohort is independent and is not affiliated with or endorsed by the USMLE program. See
[About USMLE](https://www.usmle.org/about-usmle) and the
[exam security guidance](https://www.usmle.org/what-to-know/exam-security-fairness).
This corpus uses original questions, not recalled exam items.
