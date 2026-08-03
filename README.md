# MD3

MD3 is a free and open-source learning engine with an early public USMLE Step 1
MCQ surface. This source distribution contains the reusable Next.js/React
application and a pinned open corpus of **25 original, citation-backed Step 1
questions** (incomplete blueprint coverage; descriptive progress only — not a
score or pass prediction).

The public product is deliberately fail-closed: only explicitly selected source
files and educational items with machine-verifiable rights metadata enter an
export. Software is MIT licensed; original MD3 educational content is CC BY 4.0.
Exact evidence passages keep the source-level terms recorded beside them.

Live product: [cohort.md](https://cohort.md). Source: this repository.

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

For the canonical dual-host deployment, set `AUTH_TRUST_MD3_COHORT_HOSTS=true`,
then register both `https://md3.info/api/auth/callback/google` and
`https://cohort.md/api/auth/callback/google` (and GitHub equivalents if used).
Self-hosted forks leave that flag false and set their own HTTPS `AUTH_URL`.

Verify a clean checkout:

```bash
npm run foss:boundary:audit
npm run foss:test
npm run usmle:corpus:release-gate
npm run usmle:corpus:seed:dry
npm run build
```

## Trademark

USMLE® is a registered trademark of the Federation of State Medical Boards and
the National Board of Medical Examiners. MD3/Cohort is independent and is not affiliated with or endorsed by the USMLE program. See
[About USMLE](https://www.usmle.org/about-usmle) and
[exam security guidance](https://www.usmle.org/what-to-know/exam-security-fairness).
This corpus uses original questions, not recalled exam items.
