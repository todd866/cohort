# Contributing to MD3

MD3 is building a free and open USMLE learning product. Contributions to the
engine, accessibility, tests, documentation, source registry, and original
questions are welcome.

## Licence boundary

By contributing code, you agree that your contribution may be distributed
under MD3's MIT License. By contributing original educational content, you
agree that it may be distributed under CC BY 4.0 with attribution to “MD3
contributors.” Compatible third-party material keeps its own licence and
attribution.

Only contribute material you have the right to share. Do not copy or closely
paraphrase commercial question banks, textbooks, lecture slides, private decks,
social-media posts, or restricted images. Public accessibility is not the same
as permission to redistribute. See `LICENSE-CONTENT.md` for the complete
boundary.

## Open Step 1 questions

Repo-native questions live under `open-content/usmle/step1/`. Each question
must use original wording and include a versioned `publicUsmle` provenance
envelope. Every released item requires an exact source and passage pointer in
the checked-in source registry and an approved open evidence licence. Item
text, evidence quotations, and media are
separate works with separate rights.

Adding, removing, or changing an item also requires an intentional update to
`release-v1.json` and, when baseline membership changes, `baseline-v1.json`.
Changing a registered quote requires rechecking its canonical source and rights
page, updating `verifiedAt`, and recomputing the registry's quote-set SHA-256.
Any source metadata change also requires recomputing the full registry SHA-256.
Release and scoped-seed gates reject a receipt older than 90 days or dated in
the future.

Before proposing a content change, run:

```bash
npm run foss:boundary:audit
npm run usmle:corpus:release-gate
npm run usmle:corpus:seed:dry
npm run test:run
```

Release operators additionally run the read-only
`npm run usmle:serving-db:preflight` and
`npm run usmle:reinforcement:audit` against the intended serving database;
ordinary contributors do not need database credentials.

The automated provenance, rights, answer-key, and item-quality gates are the
release boundary. A named human sign-off is not required. Reports from learners
and maintainers remain valuable inputs, but no source or rights claim may be
inferred from reputation or approval alone.

If a change adds or removes application-source paths under the explicit FOSS
candidate roots, `foss:boundary:audit` fails until the deterministic path lock
is refreshed with `npm run foss:boundary:write`. The policy intentionally keeps
legacy content, private-bank links, audit/data products, and uncleared media out
of source exports; see `docs/ops/FOSS_DISTRIBUTION.md`.

## Medical-content standard

- Write one-best-answer questions with a clear learning objective and plausible
  distractors.
- Cite the exact official or openly licensed passage that entails the keyed
  claim; a related page is not enough.
- Keep explanations within what the cited evidence supports.
- Prefer text-only items until every media asset has typed rights and
  attribution.
- Do not claim exam-score or pass prediction without prospective calibration.
- Treat all material as education, not medical advice.

## Engineering changes

Use Node.js 24.x, preserve the answer-safe pre-grade contract, and add tests for
behavior changes. Ordinary `npm run build` is deterministic and database-free;
`npm run build:release` is the fail-closed database-backed deployment build.

Please keep pull requests scoped and describe the provenance or behavioral
contract they change. Never include credentials, identifiable learner data, or
patient-linked material.
