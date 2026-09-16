import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCohortHostname } from '@/lib/institution';
import {
  parsePublicVisualAssetManifestV1,
  publicVisualAssetReleaseFailures,
  publicVisualSvgFailures,
} from '@/lib/cohort/public-visual-assets';
import publicVisualAssetManifestJson from '../../../open-content/usmle/step1/visual-assets-v1.json';
import { OPEN_FIGURE_PREFIX, isOpenFigurePath } from './open-figure-access';
import { getOriginalFigure } from './original-figure-manifest';

/**
 * Shared implementation of the app-origin figure boundary.
 *
 * `next.config.ts` rewrites ALL of `/figures/:path*` to the block route, so
 * this is the single place that decides whether any app-origin figure request
 * is answered. Everything is denied by default except the repo-native CC BY
 * Step 1 corpus and exact, reviewed MIT originals admitted by their manifest.
 *
 * The allow-list lives here — reviewed, unit-tested code — rather than in a
 * rewrite pattern, where a typo would unblock every copyright-tier figure at
 * once.
 */

const BLOCKED_FIGURE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
} as const;

// Immutable because each asset id is version-suffixed (…-v1.svg): a revision
// ships as a new id rather than new bytes at the same URL.
const OPEN_FIGURE_HEADERS = {
  'Content-Type': 'image/svg+xml; charset=utf-8',
  'Cache-Control': 'public, max-age=31536000, immutable',
  Vary: 'Host',
} as const;

// Managed clinical media can be revoked or age out of annual review. Never let
// a browser/CDN extend a once-valid receipt past the next gate evaluation.
const MANAGED_FIGURE_HEADERS = {
  'Content-Type': 'image/svg+xml; charset=utf-8',
  'Cache-Control': 'private, no-store',
  Vary: 'Host',
} as const;

const publicVisualAssetManifest = parsePublicVisualAssetManifestV1(
  publicVisualAssetManifestJson,
  'foss',
);
const manifestAssetByFilename = new Map(
  publicVisualAssetManifest.assets.map((asset) => [
    asset.relativePath.replace(/^media\//, ''),
    asset,
  ]),
);
/**
 * Grandfathered open diagrams that predate the reviewed visual manifest.
 * This list is intentionally exact: every new filename must enter a manifest,
 * regardless of whether it happens to use an ECG/CXR/dermatology naming style.
 */
const LEGACY_OPEN_FIGURE_FILENAMES = new Set([
  'adrenal-zones-v1.svg',
  'ans-divisions-v1.svg',
  'baroreceptor-reflex-v1.svg',
  'bilirubin-metabolism-v1.svg',
  'biostats-contingency-v1.svg',
  'biostats-hypothesis-v1.svg',
  'blood-components-v1.svg',
  'bone-joint-v1.svg',
  'bone-remodeling-v1.svg',
  'cardiac-cycle-v1.svg',
  'cell-cycle-genes-v1.svg',
  'cellular-respiration-v1.svg',
  'central-dogma-v1.svg',
  'cns-pathways-v1.svg',
  'ec-coupling-v1.svg',
  'energy-storage-v1.svg',
  'enzyme-regulation-v1.svg',
  'epi-association-measures-v1.svg',
  'epi-morbidity-measures-v1.svg',
  'fertilization-implantation-v1.svg',
  'frank-starling-v1.svg',
  'gas-exchange-v1.svg',
  'gastric-secretion-v1.svg',
  'gi-absorption-v1.svg',
  'gi-motility-v1.svg',
  'hb-o2-curve-v1.svg',
  'hbv-serology-v1.svg',
  'hemodynamics-v1.svg',
  'hemostasis-cascade-v1.svg',
  'hormone-signaling-v1.svg',
  'hpa-axis-v1.svg',
  'immuno-defense-layers-v1.svg',
  'influenza-antigen-v1.svg',
  'inheritance-patterns-v1.svg',
  'insulin-glucagon-v1.svg',
  'learning-types-v1.svg',
  'lung-mechanics-v1.svg',
  'male-reproduction-v1.svg',
  'memory-systems-v1.svg',
  'menstrual-cycle-v1.svg',
  'micro-pathogen-virulence-v1.svg',
  'muscle-types-v1.svg',
  'nephron-overview-v1.svg',
  'nephrotic-syndrome-v1.svg',
  'neuron-ap-v1.svg',
  'nmj-v1.svg',
  'pacemaker-ap-v1.svg',
  'passive-immunity-v1.svg',
  'pharm-drug-classes-v1.svg',
  'renal-acid-base-v1.svg',
  'renal-countercurrent-v1.svg',
  'sarcomere-bands-v1.svg',
  'tetanus-pathogenesis-v1.svg',
  'thyroid-synthesis-v1.svg',
  'vaccine-types-v1.svg',
]);

export interface OpenFigureRequestContext {
  hostname?: string;
  /** Explicit date makes the annual clinical/privacy review gate deterministic in tests. */
  today?: string;
}

/** Where the private checkout and the deployed build keep the served copy. */
const PUBLIC_FIGURE_DIR = join(
  process.cwd(),
  'public',
  ...OPEN_FIGURE_PREFIX.split('/').filter(Boolean),
);

/**
 * The canonical open-corpus location, and the only one a FOSS clone has.
 *
 * `public/figures` is a forbidden prefix in the distribution policy — it holds
 * 623 rights-managed files — so the exported artifact ships these SVGs here
 * instead. `wire-open-figure.ts` copies media -> public in the private tree, so
 * the two are byte-identical by construction (verified for all 55 assets).
 */
export const OPEN_CONTENT_MEDIA_DIR = join(
  process.cwd(),
  'open-content',
  'usmle',
  'step1',
  'media',
);

const FIGURE_SEARCH_DIRS = [PUBLIC_FIGURE_DIR, OPEN_CONTENT_MEDIA_DIR];

/** Read one already-validated filename from a specific directory. */
export function readOpenFigureFrom(dir: string, filename: string): string | null {
  try {
    return readFileSync(join(dir, filename), 'utf8');
  } catch {
    return null;
  }
}

export function blockedFigureResponse(): Response {
  return new Response(null, { status: 404, headers: BLOCKED_FIGURE_HEADERS });
}

/**
 * Validate a manifest-managed visual at the byte boundary, not only when a
 * question is selected. This prevents a copied or stale public file from
 * bypassing its Cohort-only surface, rights, safety, and hash receipts.
 */
export function isManifestManagedFigureAllowed(
  filename: string,
  svg: string,
  context: OpenFigureRequestContext,
): boolean {
  const asset = manifestAssetByFilename.get(filename);
  if (!asset) return false;
  const hostname = context.hostname ?? '';
  if (!isCohortHostname(hostname)) return false;
  if (asset.relativePath !== `media/${filename}`) return false;
  if (publicVisualAssetReleaseFailures(asset, {
    target: 'cohort',
    host: 'cohort.md',
    manifestRoot: 'open-content',
    intendedUse: 'prompt',
    ...(context.today ? { today: context.today } : {}),
  }).length > 0) {
    return false;
  }
  if (publicVisualSvgFailures(svg).length > 0) return false;
  const sha256 = createHash('sha256').update(svg, 'utf8').digest('hex');
  return asset.sha256 === `sha256:${sha256}`;
}

/**
 * Resolve the rewritten path segments to open-corpus SVG bytes, or null to deny.
 * Accepts the raw catch-all segments exactly as Next supplies them.
 */
export function readOpenFigure(
  segments: string[] | undefined,
  context: OpenFigureRequestContext = {},
): string | null {
  if (!segments || segments.length === 0) return null;

  const requested = `/figures/${segments.join('/')}`;
  // This reader is only for Step 1 SVGs. Original PNGs have their own manifest
  // and byte validation below, even though both are publicly accessible.
  if (!requested.startsWith(OPEN_FIGURE_PREFIX) || !isOpenFigurePath(requested)) return null;

  const filename = requested.slice(OPEN_FIGURE_PREFIX.length);
  const manifestManaged = manifestAssetByFilename.has(filename);
  if (!manifestManaged && !LEGACY_OPEN_FIGURE_FILENAMES.has(filename)) return null;
  for (const dir of FIGURE_SEARCH_DIRS) {
    const svg = readOpenFigureFrom(dir, filename);
    if (svg === null) continue;
    if (manifestManaged && !isManifestManagedFigureAllowed(filename, svg, context)) {
      return null;
    }
    return svg;
  }
  // An absent asset is indistinguishable from a blocked one, by design.
  return null;
}

export function openFigureResponse(
  segments: string[] | undefined,
  withBody: boolean,
  context: OpenFigureRequestContext = {},
): Response {
  const original = getOriginalFigure(`/figures/${segments?.join('/') ?? ''}`);
  if (original) {
    // The build validates and installs these exact bytes as static files.
    // Keep hundreds of full-resolution PNGs out of the serverless function.
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/medical-diagrams/${original.sha256}.png`,
        // Original ids are stable rather than versioned. A new review may
        // change their bytes, so clients must revalidate instead of caching forever.
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  const svg = readOpenFigure(segments, context);
  if (svg === null) return blockedFigureResponse();
  const filename = segments?.length === 3
    && segments[0] === 'usmle'
    && segments[1] === 'step1'
    ? segments[2]
    : null;
  const headers = filename && manifestAssetByFilename.has(filename)
    ? MANAGED_FIGURE_HEADERS
    : OPEN_FIGURE_HEADERS;
  return new Response(withBody ? svg : null, { status: 200, headers });
}
