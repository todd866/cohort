/**
 * Classify a grounding source into a rights-and-authority tier.
 *
 * Two questions are answered at once, because for this corpus they have the
 * same answer (see docs/designs/2026-09-13-content-rights-provenance.md):
 *
 *   - Is this the authority a student is examined against?   (pedagogy)
 *   - Is it something a reader can go and check?             (rights)
 *
 * A source promotes a card toward publishable only if BOTH hold. Toronto Notes
 * fails the first; UpToDate fails the second; a textbook fails both.
 *
 * PRECISION MATTERS IN ONE DIRECTION ONLY. Classifying a real guideline as
 * `unknown` costs us a card we could have published — recoverable. Classifying
 * a textbook as `guideline` publishes someone else's expression — not
 * recoverable. So `guideline` is awarded only on a publisher domain or an
 * explicit allowlist entry, never inferred from a title, and everything
 * unrecognised falls to `unknown`.
 */

export type SourceTier = 'guideline' | 'literature' | 'textbook' | 'unknown';

/**
 * TWO AXES, DELIBERATELY SEPARATE. Conflating them is the trap this module
 * exists to avoid.
 *
 *   tier         — is the source authoritative enough that a card grounded in
 *                  it may be published AS OURS? (RCH: yes. Kumar & Clark: no.)
 *   licence.cls  — may we redistribute the source's OWN WORDS?
 *
 * They are not the same and they frequently disagree. An RCH clinical practice
 * guideline is the strongest possible thing to ground a card against and is
 * NOT freely licensed: publicly readable, still copyrighted. So a card whose
 * claim it supports is publishable, while the guideline's text is not.
 *
 * md3 already uses `licence: { cls, id, url }` on every source in
 * `open-content/usmle/step1/sources.json`, where all 133 sources are
 * `cls: 'foss'` (us-gov public domain or cc-by-4.0) precisely because that
 * corpus ships source passages verbatim. The private grounding corpus does
 * not, and must not start.
 *
 * Practical consequence, enforced by `mayRedistributeSourceText`: a grounded
 * citation ships as a REFERENCE (title, publisher, url, tier) whatever its
 * tier, and ships its verbatim quote only when the source is `foss`.
 */
export type LicenceClass = 'foss' | 'public-readable' | 'restricted' | 'unknown';

export interface SourceTierResult {
  tier: SourceTier;
  /** Why this tier was chosen, so a classification can be audited later. */
  reason: string;
}

export interface SourceTierInput {
  title?: string | null;
  url?: string | null;
  doi?: string | null;
  /** Publisher-prefixed slug from the grounding corpus, e.g. `rch-febrile-child`. */
  sourceSlug?: string | null;
}

/**
 * Publisher prefixes used by `sourceSlug` in the grounding corpus.
 *
 * This is the only high-precision signal for the ~2,300 citations that carry no
 * URL at all — the harvesters record the publisher here even when the source
 * document has no stable link. Without it the classifier fails closed on real
 * guidelines: measured 2026-09-13, domain-only classification found 51
 * promotable citations where slug-prefix classification finds ~1,000.
 *
 * `md5-` is deliberately absent: it marks a hashed PDF with no publisher
 * identity, which is how the textbook corpus is stored.
 */
const GUIDELINE_SLUG_PREFIXES: ReadonlyArray<string> = Object.freeze([
  'rch',      // Royal Children's Hospital Melbourne CPGs
  'ranzcog',  // RANZCOG statements and clinical guidelines
  'aih',      // Australian Immunisation Handbook
  'qcg',      // Queensland Clinical Guidelines
  'anzcor',   // Australian and NZ Committee on Resuscitation
  'nsw',      // NSW Health Policy Directives
  'nswpds',   // the same directives, as LocalEvidence slugs them (health.nsw.gov.au)
  'ascia',    // ASCIA guidelines and position papers (allergy.org.au)
  'aah',      // Australian Asthma Handbook (asthmahandbook.org.au)
  'acsqhc',   // ACSQHC Clinical Care Standards (safetyandquality.gov.au)
  // Not `etg`: eTG is subscription-only, and tg.org.au is absent from the
  // domain list for that reason. The slug path must agree with the domain path.
  'nice',
  'who',
]);

/**
 * Domains whose content IS clinical guidance a clinician would cite as
 * authority, and which a reader can open without a subscription.
 */
const GUIDELINE_DOMAINS: ReadonlyArray<string> = Object.freeze([
  // Australian paediatric and hospital CPGs
  'rch.org.au',
  'schn.health.nsw.gov.au',
  // Australian government and statutory
  'health.gov.au',
  'immunisationhandbook.health.gov.au',
  'health.nsw.gov.au',
  'health.qld.gov.au',
  'health.vic.gov.au',
  'safetyandquality.gov.au',
  'nhmrc.gov.au',
  // Australian colleges, societies and handbooks
  'anzcor.org',
  'ranzcog.edu.au',
  'racgp.org.au',
  'racp.edu.au',
  'anzics.com.au',
  'asthmahandbook.org.au',
  'allergy.org.au',
  'cancer.org.au',
  // International guidance used as local standard
  'who.int',
  'nice.org.uk',
  'ginasthma.org',
  'kdigo.org',
  'erc.edu',
]);

/**
 * Distinctive fragments of textbook and exam-compendium titles. Matched
 * case-insensitively against the title. These never promote; they are listed so
 * the classifier can say "textbook" rather than "unknown", which is useful for
 * reporting even though both are equally unpublishable.
 */
const TEXTBOOK_TITLE_MARKERS: ReadonlyArray<string> = Object.freeze([
  'kumar and clark', 'kumar & clark',
  'bailey and love', 'bailey & love',
  'robbins',
  'toronto notes',
  'first aid for the usmle', 'first aid usmle',
  'harrison',
  'goodman and gilman', 'goodman & gilman',
  'talley',
  'dejong', "dejong's", 'dejongs',
  'washington manual',
  'oxford handbook',
  'nelson textbook',
  'moss adams', 'moss and adams',
  'white coat companion',
  'learning radiology',
  'textbook of',
  'clinical cases uncovered',
  'kaplan', 'sadock',
  'schwartz',
  'gray’s anatomy', "gray's anatomy",
  'netter',
  'uptodate',
  'bmj best practice',
  'amboss',
  'osmosis',
]);

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function matchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function classifySourceTier(input: SourceTierInput): SourceTierResult {
  const host = hostOf(input.url);
  const title = (input.title ?? '').toLowerCase();

  // A textbook marker wins over any domain: a textbook chapter served from a
  // health domain is still a textbook, and this is the direction where a wrong
  // answer is unrecoverable.
  const marker = TEXTBOOK_TITLE_MARKERS.find((m) => title.includes(m));
  if (marker) return { tier: 'textbook', reason: `title matches textbook marker "${marker}"` };

  if (host) {
    const domain = GUIDELINE_DOMAINS.find((d) => matchesDomain(host, d));
    if (domain) return { tier: 'guideline', reason: `publisher domain ${domain}` };
    if (matchesDomain(host, 'doi.org')) {
      return { tier: 'literature', reason: 'DOI — citable literature, open access not established' };
    }
  }
  if (input.doi) {
    return { tier: 'literature', reason: 'DOI — citable literature, open access not established' };
  }

  const slug = (input.sourceSlug ?? '').toLowerCase();
  if (slug) {
    const prefix = slug.split('-')[0];
    if (GUIDELINE_SLUG_PREFIXES.includes(prefix)) {
      return { tier: 'guideline', reason: `sourceSlug publisher prefix "${prefix}-"` };
    }
    if (prefix === 'md5') {
      return { tier: 'unknown', reason: 'md5- slug: hashed PDF with no publisher identity' };
    }
    if (/^10\./.test(slug) || prefix === '10') {
      return { tier: 'literature', reason: 'DOI-shaped slug — open access not established' };
    }
  }

  return { tier: 'unknown', reason: 'no recognised publisher domain, slug prefix or title marker' };
}

/**
 * Whether a source is strong enough to promote a card to `authored`.
 *
 * Only `guideline`. `literature` is deliberately excluded until open-access
 * status is established per source — a DOI proves the work is citable, not that
 * the reader can read it, and the design requires both.
 */
export function promotesToAuthored(result: SourceTierResult): boolean {
  return result.tier === 'guideline';
}

/**
 * Whether the source's OWN WORDS may be redistributed — i.e. whether a grounded
 * citation may ship its verbatim `quote` rather than just a reference.
 *
 * Only an explicitly FOSS-licensed source qualifies. A guideline being freely
 * readable on the open web is not a licence to republish it, and the default
 * for an unlabelled source is no.
 */
export function mayRedistributeSourceText(licence: { cls?: string | null } | null | undefined): boolean {
  return licence?.cls === 'foss';
}

/**
 * Whether a CARD may be promoted to `authored`.
 *
 * Deliberately takes provenance as well as the source tier, because the two
 * answer different questions and only both together are sufficient:
 *
 *   - tier `guideline`     — the CLAIM is authoritative and checkable
 *   - provenance not import — the WORDING is ours
 *
 * Grounding alone must never promote. Measured 2026-09-13, 26 AnKing/Malleus
 * imported cards are grounded in guideline-tier sources: their claims check out
 * against RCH and RANZCOG, and their text is still somebody else's expression.
 * A promotion gate reading only the citation would publish them.
 */
export function cardMayBePromoted(args: {
  source: SourceTierResult;
  /** Current rights provenance of the card. */
  provenance: 'authored' | 'derived-expression' | 'import' | 'unreviewed';
}): boolean {
  if (!promotesToAuthored(args.source)) return false;
  return args.provenance === 'unreviewed' || args.provenance === 'authored';
}
