# FOSS distribution boundary

The Git repository is broader than the material MD3 can publish. It contains
legacy course content, a tracked symlink to a private sibling question bank,
operational audits, local data products, and media with mixed rights. Repository
visibility and file presence are therefore not the release boundary.

The machine-readable boundary is:

```text
foss/distribution-policy.json   candidate roots, exclusions, safety rules
foss/distribution-paths.txt     exact reviewed path set
```

The policy includes the MIT application source, only the Prisma schema and
migration trees, build/bootstrap support needed by the open vertical, and every
current file in the repo-native `open-content/usmle/step1` corpus by explicit
path. Broad Prisma seeds and their
legacy curriculum/source registries are not selected. The exported artifact
records MIT, CC-BY-4.0, OFL-1.1, and mixed per-source rights separately.
Copied authored documents are also admitted by exact path and require an exact
CC-BY-4.0 licence override for that path. There is no directory-wide `docs/`
relicensing rule: selecting an unclassified document fails closed. The archived
personal/community-derived Step 1 checklist is not part of the public artifact.
Tests under candidate roots are non-candidates by default: the small public
suite is admitted only by exact `includeFiles` entries. Adding a private fixture
beside public runtime code therefore cannot expand the artifact silently.
Application exposure is locked separately from file selection: the auditor
requires exact equality with the reviewed page, API-route, non-API
route-handler, metadata-route, and App Router layout/error/loading sets declared in
`scripts/foss/distribution.ts`. A new `page.*`, `route.*`, layout, template,
loading, or error entry fails closed even if its parent directory was already
inside the software candidate root.

## Clean-checkout audit

Use Node 24 and install the locked dependencies, then run both the repository
boundary and the question-level provenance gate:

```bash
nvm use
npm ci
npm run foss:boundary:audit
npm run foss:test
npm run usmle:corpus:release-gate
npm run usmle:corpus:seed:dry
npm run build
```

`foss:boundary:audit` reads only the working tree. It does not open Prisma,
query a database, follow a symlink, print file contents, or change state. A new
or removed file under an included candidate root fails as boundary drift. In
the private source checkout this command is a strict audit. In an installed
public checkout the generated package intentionally adds `--source-tree`: it
still checks the selected source, rights metadata, safety rules, and exact path
lock, but skips only the pristine artifact-manifest enumeration because
`npm ci` and a build add untracked working products.
`foss:test` is the distributable boundary/USMLE smoke suite; the internal
checkout's broad `test:run` also covers legacy surfaces that are intentionally
absent from this artifact.
Its pretest materialises the complete deterministic offline prerequisite set:
Prisma client, empty deep-dive indexes, content-map shards, starter sessions,
and image index. No test may rely on a gitignored artifact left behind by a
developer checkout. A boundary meta-test also requires every deliberately
selected public `*.test.ts(x)` file to appear in `foss:test`.

For the canonical deployment that serves both `md3.info` and `cohort.md`, set
`AUTH_TRUST_MD3_COHORT_HOSTS=true` and leave `AUTH_URL` and `NEXTAUTH_URL`
unset. Auth.js then derives the host-specific callback and cookie origin from
each trusted request. Self-hosted forks leave that flag false and set their own
HTTPS `AUTH_URL`. Register both
`https://md3.info/api/auth/callback/google` and
`https://cohort.md/api/auth/callback/google` in the Google OAuth client; if
GitHub login is enabled, register the corresponding
`/api/auth/callback/github` URI on both hosts. A public deployment also needs
`DATABASE_URL`, `NEXTAUTH_SECRET` (or `AUTH_SECRET`), and at least one complete
provider configuration before authentication is usable. Email delivery remains
disabled unless both `RESEND_API_KEY` and an operator-controlled, verified
`EMAIL_FROM` are configured. The `/usmle` route tree is a public early product:
guests and signed-in users can study the open Step 1 corpus. Guest session minting
and write paths use shared rate limits with tighter guest budgets; answer writes
require an existing session or guest cookie and do not mint new guest rows.
`ADMIN_EMAILS` remains for operator tools, not for entering `/usmle`.

The text audit also rejects known learner names and account handles in both
copied files and generated fallbacks. The sole identity exception is the exact
public-author credit when it is the complete value of an `attribution` field;
putting the same name in prose, fixtures, or a longer attribution still fails.
Reports identify only the path and matched rule, never the source line.

When a deliberate source-file addition or removal passes the mechanical safety
checks, refresh the sorted paper trail and rerun the audit:

```bash
npm run foss:boundary:write
npm run foss:boundary:audit
```

The write command changes only `foss/distribution-paths.txt` and validates the
result as a source tree. That matters in an installed public checkout: its
embedded export manifest describes the last pristine artifact and is expected
to remain stale until a fresh export is produced. Rights are not inferred from
the write command: educational content outside `open-content/usmle/step1`
remains excluded by policy.

## Export

Choose a new destination outside this repository. The exporter refuses to
overwrite an existing path.

```bash
npm run foss:export -- /tmp/md3-foss-export
```

Export first runs the same fail-closed audit, reads each selected file without
following links, normalises file modes/timestamps, and writes
`FOSS-DISTRIBUTION-MANIFEST.json` in the destination. That generated manifest
contains sorted paths, byte counts, SHA-256 hashes, modes, and licence classes;
it contains no source text.
The embedded receipt describes the exact pristine snapshot that originally
produced it; it is not treated as authority over later edits when that artifact
is used as a new source checkout. Re-export first validates the current path
lock, candidate set, rights metadata, and safety rules while ignoring only the
old receipt. It then mints a new receipt and always performs a strict self-audit
before publishing its temporary directory. When the manifest is present, that
strict mode verifies its policy hash, reviewed-path hash, file records, and
every recorded file's bytes and mode. It also enumerates the complete pristine
artifact, so an extra file, symlink, or special file fails self-audit. Public
CI repeats the strict check
against a freshly re-exported temporary artifact by invoking the installed
source exporter's CLI directly. CI then installs, tests, gates, dry-seeds, and
builds that fresh artifact rather than trusting an old checked-in receipt. Run
a strict check before `npm ci` or a build creates local products such as
`node_modules/` and `.next/`.

Two bundled Geist font files are admitted only at their pinned SHA-256 values
and retain the SIL Open Font License notice in
`THIRD_PARTY_LICENSES/Geist-OFL-1.1.txt`. The eight MD3/Cohort homescreen PNGs
are original assets generated by `scripts/ops/generate-app-icons.ts`; each is
selected by exact path, pinned by SHA-256, and classified as MIT under
`LICENSE`. A regression resolves both host-specific manifests plus the root
metadata's Apple icon and proves that every referenced asset is in the export.

`open-content/usmle/step1/sources.json` is classified as
`MIXED-PER-SOURCE`: every registry entry carries its own licence class, licence
ID, rights URL, and attribution. The current receipt contains 14 named U.S.
government sources, but the file-level class deliberately does not assume that
future entries share those terms. Exact passages retain their recorded
source-level rights and are not relicensed under MD3's CC BY grant; surrounding
original question files retain their declared CC BY item-text licence.
The exporter accepts only an explicit `foss` class with a pinned compatible
licence ID (`us-gov`, CC0 1.0, CC BY 4.0, or CC BY-SA 4.0), matching HTTPS
rights metadata, and attribution. `verify`, `unknown`, invented identifiers,
or incomplete rights metadata fail before any artifact is written.

The exporter also writes a small, declared set of generated public fallbacks.
They are listed verbatim in the policy and hashed in the artifact manifest:

- empty glossary, legacy source-registry, and deep-dive indexes, so omitted
  private content is represented as absent rather than copied implicitly;
- a dataset-free algorithm-step renderer and inert named presets, so shared MDX
  imports compile without publishing course-derived clinical teaching text;
- empty curriculum/rotation adapters, a USMLE-only navigation catalog, and an
  explicitly uncalibrated generic complexity scorer, so shared application
  imports compile without planner schedules, cohort dates, track orderings, or
  exam-derived calibration tables;
- a distribution-specific institution catalog that advertises only USMLE and
  generic open learning, rejects stale legacy institution IDs, and disables
  the omitted personal-dossier, personal-document, and clinical-exam
  capabilities. A generated no-op settings destination prevents links into the
  omitted upload surface. On the Cohort
  host, the logo and installed-app start URL resolve to the exported USMLE
  product surface rather than the legacy generic feed;
- a Step 1-only global navigation, a root redirect to `/usmle`, a `/content`
  compatibility redirect to `/usmle/step1`, a safe `/brief` redirect to
  `/profile`, and a local-only active-module hook. The public shell cannot call
  the omitted DB-backed module API or advertise removed legacy review routes;
- an inert offline
  pack filler, a no-network/no-cache figure adapter, and an honest minimal
  offline screen. Public builds do not
  bundle reachable legacy Brief/Clinical/review UI into `/offline`, advertise
  a dossier, claim downloaded answer-bearing sessions, or call the omitted
  private bulk-pack API;
- operator-neutral `/privacy` and `/terms` pages. They do not claim that the
  artifact provides self-service export/deletion or define a hosted service's
  providers, contacts, jurisdiction, or terms. Operators must implement and
  publish accurate processes before onboarding learners;
- a public `next.config.ts` that derives optional remote-media allowlists only
  from operator-supplied HTTPS URLs and contains no `/figures` rewrite or cache
  rule, plus a minimal `vercel.json` that runs the strict release build. Live
  MD3 bucket/account hostnames, private storage defaults, ECG rewrites, cron
  jobs, and region choices are absent;
- a public `package.json` with only 34 resolvable build, test, corpus, database,
  and export commands (while retaining the lockfile's exact dependency sets),
  plus a public-focused README;
- an empty API-compatible personal-deck registry, so owner authorization data
  and private deck identities are absent while shared code still compiles;
- a public `tsconfig.json` that keeps application builds independent of tests
  for omitted legacy surfaces;
- fail-closed private-source access and exam-date adapters, plus a hermetic
  public test setup, so legacy deployment-specific environment hooks do not
  enter the artifact; and
- a public `prisma.config.ts` whose default seed command is the scoped open
  USMLE seeder, never the internal broad seed. Its compile-only fallback URL
  targets unreachable localhost port 1, so dependency generation and offline
  builds need no database while database commands still fail unless an operator
  supplies `DATABASE_URL`; and
- the database command wrapper and its destructive-operation guard. A boundary
  contract resolves every relative import used by advertised `db:*` wrappers,
  so a package command cannot point through an omitted helper.

Generated paths are collision-checked against copied paths and the export
manifest. A collision, invalid path, unsupported type, oversized fallback, or
credential/learner-identifier-shaped value fails before export.

## Always excluded

The policy makes these boundaries structural rather than conventional:

- tracked legacy `content/` and the `question-bank` symlink;
- private personal-deck registries/tests, the StuAnki loader, and the archived
  AnKing/First Aid import prototype;
- `audit/`, root `data/`, fixtures, outputs, source materials, and local/private
  operational artifacts;
- generated legacy content maps and unreviewed embedded teaching datasets;
- the source checkout's course-derived rotation metadata and content landing
  index; public builds must use explicit dataset-free generated adapters rather
  than inheriting the default MIT software classification;
- course-derived schedules, quiz fixtures, ECG teaching datasets, and
  preconfigured clinical-algorithm prose;
- academic-planner curriculum maps, cohort track/date tables, summative-exam
  calibration tables, and tests copied from private/course question banks;
- the legacy private course route groups and every test that is not on the exact
  public test allowlist;
- legacy admin, card, deep-dive, flag, learn, practice, question, review,
  sandbox, study, and experimental page families. The exact public page set is
  limited to the USMLE Step 1 flow, sign-in/profile/support, offline shell,
  operator/legal information, and three explicit compatibility redirects. The
  replaced root page's legacy review-bootstrap client/server modules are also
  absent rather than retained as unreachable application baggage;
- the institution-specific clinical route, its admin navigation capability,
  and the `/x/cards` course prototype that linked into an omitted course page;
- the obsolete mobile magic-link/verification API pair, whose browser fallback
  route was never shipped; public authentication uses the ordinary Auth.js
  sign-in and verification-email flow;
- every API route except the exact reviewed 17-route alpha surface: Auth.js and
  guest-claim support; issue/help/client-error/offline/CSP/track telemetry;
  bounded profile/alias routes; and the three opaque Step 1 session, answer,
  and progress routes. Legacy cards, citations, content-lake/quality,
  terminology/glossary, sync, study, question-bank, admin/cron, module,
  integration, media-delivery, and experimental endpoints are absent. Public
  USMLE evidence comes from the checked-in source registry, and pinned inert
  shared-component adapters issue no requests to omitted APIs;
- source-only legacy quarantine/410 helpers and the PaperScope review-auth
  adapter. They serve only omitted legacy or integration routes; the MedKit
  compatibility surface is retired rather than redistributed as product code;
- legacy course routes plus authored personal-brief dossiers and fixture tests;
  the reusable brief/offline engine may remain, but its public data adapter is
  empty and no learner schedule or course dossier is distributed;
- learner-document upload and cleanup routes, private document object-storage
  helpers, the profile document UI, and the lecture/past-exam harvesting tool
  and referral flow;
- `public/figures`, quarantine, exports, personal tooling, and other media/data
  trees without an explicit distribution contract;
- precomputed `public/static-queues` answer payloads and their generator/cache
  configuration. The public product serves an opaque question first and only
  returns the explanation/correctness payload through the reviewed answer
  route;
- environment files other than the placeholder `.env.example`;
- symlinks, surprise binaries, oversized files, credential-shaped text, and
  learner identifiers outside the narrow public-author exception.

The two dataset-free adapters above are pinned in the boundary implementation
by path, licence class, and SHA-256. The rotation adapter is an empty MIT JSON
object; the generic open-learning/USMLE index is CC BY 4.0. Copying either
private source file, removing a fallback, changing its licence, or changing its
bytes fails with `non-foss-source-text` until the boundary review is updated.

The export is a distribution/provenance artifact, not a publication action. It
does not change the private GitHub repository, create a release, stage or commit
files, push, deploy, or change any external system. A fresh artifact is expected
to pass `npm ci`, `npm run foss:test`, and `npm run build` without `content/`,
`question-bank`, `figure-sidecars/`, or a database read. The build uses explicit
offline generators, including an empty deterministic image index, so it never
smuggles private sidecars into the artifact. That compile-only output is not
deployable; deployment remains restricted to `npm run build:release`, including
the read-only source-to-serving DB preflight and strict database/content/sidecar
gates. A source-green corpus is not itself a release claim.

CI repeats the clean-artifact path: export, pristine self-audit, locked install,
the fail-closed FOSS/USMLE test surface, corpus release gate, dry seed, and full
offline build. A meta-test enumerates every deliberately selected public test,
including the global reinforcement-card egress inventory, so a new exported
test cannot silently fall outside `foss:test`.
The artifact also contains its own minimal `.github/workflows/ci.yml` with the
same Node 24 install, audit, test, release-gate, dry-seed, and offline-build
sequence. The boundary rejects any public package command that points to an
unexported path, unavailable package binary, or missing nested script; exported
documentation cannot advertise a missing npm script.

The private checkout still keeps its live personal-deck authorization registry
in a module that can be imported by client-shared code. The public artifact is
safe because that module is replaced by the empty fallback above, but the live
application should separately move this registry to a server-only,
environment-backed source. That hardening is independent of the FOSS export.
