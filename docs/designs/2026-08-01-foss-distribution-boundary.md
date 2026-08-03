# FOSS distribution boundary

**Date:** 2026-08-01  
**Status:** Candidate / pending definitive artifact validation

## Problem

The MD3 repository contains MIT application source beside legacy course
content, a symlink to a private question bank, generated audit history, local
data products, and media with mixed rights. A public release cannot safely be
defined as “copy the repository and delete the private-looking parts.”

## Design

The distribution boundary is an explicit, versioned policy plus a reviewed,
sorted path manifest:

- candidate files come only from narrow application/tooling roots and explicit
  top-level files;
- legacy content, the private question-bank symlink, audit/data trees,
  generated corpora, private artifacts, legacy private course route groups, and
  uncleared media are outside the boundary;
- additions or removals inside a public candidate root create manifest drift
  and fail the audit until the path manifest is regenerated deliberately;
- test files under candidate roots are implicitly excluded unless their exact
  path is listed in `includeFiles`; the legacy integration-test root is not a
  candidate root;
- open-content files are individually selected in policy, so a new educational
  file requires both a rights-boundary change and a refreshed path lock;
- selected paths are checked for traversal, symlinks, binary surprises, size
  limits, forbidden roots, and credential-shaped text;
- copied and generated text is rejected when it contains known learner names
  or account handles; only the exact public-author credit as a complete
  `attribution` value is exempt, so the exception cannot mask a longer identity
  string;
- the source registry has a mixed/per-source rights class, so each exact
  passage retains its recorded source-level licence instead of inheriting MD3's
  CC BY default or a whole-file public-domain assumption;
- export copies only a passing manifest into a new destination, reads through
  stable file descriptors into one immutable snapshot, never follows links,
  never overwrites a destination, normalises modes/timestamps, and
  writes a content-hash manifest inside the artifact;
- private-data modules and broad Prisma seeds are omitted; a short explicit set
  of collision-checked generated files supplies empty optional-data indexes and
  an open-only Prisma seed configuration;
- institutional planner/schedule data and exam-derived calibration tables are
  replaced in the artifact by API-compatible empty or explicitly uncalibrated
  adapters, rather than being treated as MIT source without a rights receipt;
- the public institution adapter enumerates only USMLE and generic open
  learning. It disables absent dossier, personal-document, and clinical
  capabilities; `/brief` falls back to `/profile`; the settings page receives
  a generated no-op document destination; and the shared offline warmer uses a
  generated no-network filler because the private bulk-pack endpoint is not
  distributed;
- the public App Router surface is an exact machine-enforced allowlist: 16
  pages, 17 API handlers, the host-aware web-manifest handler, two dynamic
  icon/robots metadata routes, and nine reviewed layout/error/loading modules.
  A newly selected `page.*`, `route.*`, metadata route, layout, template,
  loading, or error file is a boundary error, even when it appears below an
  otherwise selected software root;
- the legacy root and content pages are replaced by `/usmle` and
  `/usmle/step1` redirects, global navigation exposes only Step 1, About, and
  Profile/sign-in, and active-module state is local-only. This prevents a
  nominally open alpha from presenting routes backed by omitted private APIs;
  the replaced root's legacy review-bootstrap modules are omitted too;
- `/offline` receives a minimal reconnect screen rather than the source
  checkout's legacy Brief/Clinical/review shell. It does not claim that the
  alpha downloads answer-bearing sessions or retain a reachable import chain
  into omitted card, study, figure, and video endpoints; its figure adapter is
  an exact-hash-pinned no-network/no-cache implementation;
- the source-only legacy API quarantine/MedKit retirement helpers and
  PaperScope review-auth adapter are omitted with the routes they serve; they
  are not part of the Step 1 product contract;
- document upload/cleanup APIs, the private object-store adapter, the document
  profile page, and the course/past-exam harvesting tool are outside the public
  path lock. Public navigation tests reject static links or referrals back into
  those omitted surfaces;
- all host-specific PWA icons are admitted as original MIT assets by exact
  path and SHA-256, and navigation/manifest tests resolve every advertised
  route and asset against the artifact path set;
- course-derived rotation metadata and content-index teaching data are copied-
  source exclusions; any public equivalents must be explicit dataset-free
  generated adapters instead of silently receiving the default MIT class, and
  those adapters are pinned by path, licence, and SHA-256;
- the private 300-plus-command package surface is replaced by a minimal public
  package whose dependencies remain lockfile-exact and whose commands all
  resolve inside the artifact; a minimal public CI workflow proves that same
  artifact on every push and pull request;
- deployment configuration is generated rather than copied: `next.config.ts`
  admits only operator-supplied HTTPS media origins and has no public
  `/figures` rewrite/cache rule or live bucket, account, or ECG defaults, while
  `vercel.json` contains only the framework and fail-closed release-build
  command;
- generated `/privacy` and `/terms` routes make no claims about a particular
  operator, provider, jurisdiction, or missing account controls. They require
  operators to implement and publish verified privacy and service processes
  before onboarding and preserve the checked-in software/content reuse rights;
- audit output contains paths, counts, sizes, hashes, and reason codes only. It
  never prints file contents.
- an exported artifact self-audits against its embedded policy/path hashes and
  per-file records, so post-export byte or mode drift fails closed;
- artifact self-audit requires the complete file set to match the manifest, so
  unrecorded files, symlinks, and special files fail closed;
- installed public checkouts use an explicit source-tree audit mode that skips
  only pristine manifest enumeration; path-lock refresh and re-export apply
  those source semantics internally, while generated output and its CI check
  always use strict mode. The source-tree flag is rejected as an extra modifier
  for export/path writes;
- re-export treats an older embedded receipt as evidence for its original
  snapshot rather than current-source authority, then revalidates the exact
  current boundary and strictly self-audits the freshly generated artifact;
- source entries require an accepted FOSS licence ID, rights URL, and
  attribution; an unresolved or self-invented class cannot enter an export;

The current repo-native `open-content/usmle/step1` files are explicitly selected
as educational content. Other educational/data/media trees stay excluded until a separate
machine-verifiable rights contract explicitly admits them.

## Test cases

1. A policy fixture with a matching path manifest audits successfully.
2. A new runtime candidate fails as unreviewed boundary drift.
3. An unlisted test under an included root remains outside the candidate and
   reviewed sets; listing its exact path admits it.
4. A removed reviewed file fails as missing boundary drift.
5. A forbidden path, selected symlink, unsupported binary, or credential-shaped
   value fails closed.
6. Known learner identifiers fail in copied and generated text, while the exact
   public-author attribution field value remains allowed.
7. Export refuses an existing destination and contains only reviewed files plus
   a deterministic hash manifest.
8. The checked-in policy excludes `content/`, `question-bank`, `audit/`, root
   `data/`, private/output artifacts, generated legacy corpora, and uncleared
   public media.
9. The reviewed path lock excludes private learner/course fixtures, legacy
   private course route groups, and the two embedded course-data modules that require
   dataset-free public adapters.
10. Generated fallbacks cannot collide with copied or reserved paths.
11. A fresh export installs from the lockfile and completes the deterministic
   offline Next build without private content, bank, or figure-sidecar trees.
12. The selected page/API/route-handler/metadata/layout/error/loading sets must
    exactly equal their reviewed allowlists; adding either a TypeScript or
    JavaScript App Router entry fails closed.
13. Precomputed static queues, their answer-bearing JSON, generator, package
    command, and cache configuration remain absent from the artifact.

## Scope

- `foss/distribution-policy.json` — machine-readable boundary policy
- `foss/distribution-paths.txt` — reviewed path lock
- `scripts/foss/distribution.ts` — audit, lock refresh, and export CLI
- `scripts/foss/distribution.test.ts` — fail-closed contract tests
- `docs/ops/FOSS_DISTRIBUTION.md` — operator/bootstrap runbook
- `package.json`, CI, README, contribution/open-content docs — command wiring

No file is moved or deleted, repository visibility is unchanged, and the tool
does not stage, commit, push, deploy, or mutate external state.

## 2026-08-01 candidate verification checklist

The release candidate closes the public product surface as well as the file-copy
boundary:

- Auth.js fixed-origin variables are neutralized only for the known first-party
  dual-host deployment, so MD3 and Cohort derive host-only cookies and callback
  URLs from each trusted request. The public runbook requires both OAuth
  callback URIs to be registered, `AUTH_TRUST_MD3_COHORT_HOSTS=true`, and
  `AUTH_URL`/`NEXTAUTH_URL` to remain unset for that topology. Self-hosted forks
  leave the flag false and supply their own HTTPS origin. Verification email
  wrappers and product copy use an
  allowlisted callback origin; hostile suffixes, credentials, non-callback
  paths, and production loopback are rejected before email send.
- Email-alias enrollment returns 503 before a write when delivery is not
  fully configured with both an API key and operator-controlled sender,
  rate-limits verification mail, generates same-host branded
  links, cleans up on delivery failure, and atomically consumes the token with
  alias verification. Every outcome returns to the shipped `/profile/settings`
  route rather than a dead top-level settings page.
- Cohort's logo and installed-app start URL resolve to the USMLE product;
  the public root redirects to `/usmle`, the compatibility content route
  redirects to `/usmle/step1`, and the global navigation does not present the
  removed generic queue;
- only the USMLE and generic open-learning institutions are advertised;
  omitted MD1/MD2, clinical-exam, personal-dossier, personal-document,
  harvesting, legacy mobile-auth, and private bulk-offline routes are absent or
  capability-disabled, with `/brief` safely returning to `/profile`.
- the `/usmle` tree is a public early product for guests and signed-in users;
  the quick start no longer requires `ADMIN_EMAILS` to enter `/usmle`
  (`ADMIN_EMAILS` remains for operator tools only);
- legacy database-backed citation/terminology/glossary excerpts, raw bulk
  card/question/glossary sync, direct legacy question lookup, exam high-yield,
  and localhost-only admin tools are absent. The open USMLE vertical uses the
  checked-in source registry and opaque dedicated answer/session routes
  instead; shared glossary and MDX components receive pinned inert adapters so
  they issue no requests to omitted APIs;
- the exact public API set contains only the 17 handlers required by auth,
  bounded profile/support/telemetry, and the Step 1 vertical. The exact 16-page
  set contains only the Step 1 flow, sign-in/profile/support, offline and
  operator/legal pages, plus the reviewed root/content/brief/chapter
  compatibility redirects. The web manifest is the sole non-API handler;
- answer-bearing `public/static-queues` JSON, its generator, package command,
  and cache header are absent. Public items cross the reveal boundary only
  through the opaque Step 1 answer route;
- analytics is disabled unless an operator opts in, `.env.example` contains no
  non-empty key, email-sender, account, bucket, or live media-host default, and
  public configuration contains no MD3-owned delivery identity;
- generated operator-neutral Privacy and Terms routes are linked from the app
  shell. They do not invent self-service account export/deletion, contact,
  provider, or jurisdiction claims; operators must publish a deployment-specific
  process before onboarding learners.
- every referenced MD3/Cohort homescreen icon is present, exact-hash pinned,
  and classified as an original MIT asset.
- the learner surface and generated public README state that MD3/Cohort is an
  independent, non-endorsed project using original questions, prohibit recalled
  live-exam content, and link the official USMLE program and exam-security
  pages.

Exact file/byte/licence counts and the artifact digest are intentionally not
recorded while this remains a candidate. They must be copied from the final
strict audit after the source tree is frozen and the independently built
artifacts compare byte-for-byte. Source checks run before that freeze are
evidence of progress, not release claims.

The definitive handoff additionally requires two exports from this same frozen
tree to be byte-for-byte identical, a strict pristine manifest audit, no
symlinks or special files, a clean locked dependency install, application and
scripts typechecks, lint, the full public suite, release gate, dry seed, offline
production build, and a final post-build source-boundary audit. Artifact paths
and SHA-256 receipts are intentionally reported outside the artifact: embedding
an artifact hash inside a hashed input would be self-referential.
