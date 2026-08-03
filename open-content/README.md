# MD3 open educational content

This directory is the repo-native source of content that MD3 intends to
redistribute. It is deliberately separate from the private `question-bank`
symlink and from imported course, deck, textbook, and social-media material.

Unless a file records another compatible licence, original educational content
here is licensed under CC-BY-4.0 as described in `LICENSE-CONTENT.md`.
The exact U.S.-government passages in `usmle/step1/sources.json` remain public
domain with their recorded source attribution and rights URLs; MD3 does not
relicense those quotations as CC BY. The registry is classified per source, so
any future source keeps its own recorded compatible FOSS terms rather than
inheriting the current entries' public-domain status. Unresolved or
nonredistributable terms fail the exporter.

Presence in this directory is not enough for release. Each item must pass its
versioned provenance contract, source-registry checks, content validation, and
the public corpus release gate. Unknown rights fail closed.

## USMLE Step 1

- Questions: `usmle/step1/questions/<domain>/*.json`
- Evidence registry: `usmle/step1/sources.json`
- Baseline membership: `usmle/step1/baseline-v1.json`
- Production release allowlist: `usmle/step1/release-v1.json`

Run the read-only audit before seeding or exporting:

```bash
npm run foss:boundary:audit
npm run usmle:corpus:release-gate
npm run usmle:corpus:seed:dry
```

The dry seed validates the standalone FOSS loader and performs no database
writes. To bootstrap only the open corpus into a configured MD3 database, run
`npm run db:seed:usmle-open`; it does not load the private sibling bank.

`sources.json` is a dated verification receipt, not a permanent assertion. Its
HTTPS URLs, exact passages, rights pages, `verifiedAt` date, and quote-set
SHA-256 must be rechecked and intentionally refreshed when the evidence changes.
A second SHA-256 covers the dated full registry, including URLs, attribution,
rights metadata, locators, and quotes.
The release and scoped-seed gates also reject a receipt older than 90 days or
dated in the future, so an unattended registry cannot remain release-green.
The release allowlist must exactly match the source corpus; adding a question
file alone never makes it servable. The database preflight is read-only and
must match every released source projection before a strict release build; it
is a release-operator check and does not require contributor DB access.

Do not copy or paraphrase commercial question-bank stems, options,
explanations, proprietary diagrams, or deck wording into this tree.
