# MD3

MD3 is a free and open-source spaced-repetition learning platform. This source distribution contains the reusable Next.js/React learning engine and an initial citation-backed USMLE Step 1 question corpus.

The public product is deliberately fail-closed: only explicitly selected source files and educational items with machine-verifiable rights metadata enter an export. Software is MIT licensed; original MD3 educational content is CC BY 4.0. Exact evidence passages keep the source-level terms recorded beside them.

## Quick start

Node.js 24 and PostgreSQL are required.

```bash
npm ci
cp .env.example .env.local
# Set DATABASE_URL and NEXTAUTH_SECRET.
# /usmle is a public early product: guests and signed-in users can study.
# Configure at least one provider: GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET,
# GITHUB_ID + GITHUB_SECRET, or RESEND_API_KEY + EMAIL_FROM.
# For canonical dual-host MD3/Cohort, set AUTH_TRUST_MD3_COHORT_HOSTS=true and
# leave AUTH_URL and NEXTAUTH_URL unset.
npm run db:push
npm run db:seed:usmle-open
npm run dev
```

For the canonical dual-host deployment, set `AUTH_TRUST_MD3_COHORT_HOSTS=true`, then register both `https://md3.info/api/auth/callback/google` and `https://cohort.md/api/auth/callback/google` with the Google OAuth client. Register the equivalent `/api/auth/callback/github` URI on both hosts when GitHub login is enabled. Leave `AUTH_URL` and `NEXTAUTH_URL` unset so Auth.js derives the correct first-party origin from each trusted request.

MD3 and Cohort are independent educational projects and are not affiliated with or endorsed by the USMLE program, FSMB, or NBME. All question text is original; recalled or reconstructed live-exam content is prohibited. See the official [About the USMLE](https://www.usmle.org/about-usmle) and [Exam Security & Fairness](https://www.usmle.org/what-to-know/exam-security-fairness) pages.

The application is educational software, not medical advice. Operators must configure their own privacy, authentication, email, analytics, and retention practices.

## Verify the public product

```bash
npm run foss:boundary:audit
npm run foss:test
npm run usmle:corpus:release-gate
npm run usmle:corpus:seed:dry
npm run build
```

The ordinary build is deterministic and database-free. A deployable build is stricter:

```bash
npm run usmle:serving-db:preflight
npm run usmle:reinforcement:audit
npm run build:release
```

The release path requires the configured serving database to match the checked-in corpus and refuses active answer-bearing reinforcement cards. It never seeds or repairs data implicitly.

## Repository map

- `open-content/usmle/step1/` — explicitly licensed questions, release manifests, and evidence registry.
- `src/app/usmle/` — Step 1 learner UI.
- `src/lib/usmle/` — corpus, session, provenance, drift, and delivery contracts.
- `scripts/foss/` — exact source-distribution audit and exporter.
- `docs/ops/FOSS_DISTRIBUTION.md` — distribution and clean-build runbook.
- `docs/ops/USMLE_PUBLIC_CORPUS.md` — corpus, seed, preflight, and release runbook.
- `CONTRIBUTING.md` — contribution and provenance rules.

## Reuse and contribution

Code is available under the MIT License in `LICENSE`. Original MD3 educational content and documentation are available under CC BY 4.0 as described in `LICENSE-CONTENT.md`. Compatible third-party works retain their own terms and attribution. Contributions are welcome; do not submit commercial-bank, textbook, lecture, private-deck, or uncleared media content.
