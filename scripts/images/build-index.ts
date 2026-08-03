import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { ImageSidecar } from '@/lib/images/types';

// Sidecar files are named <slug>.<image-ext>.json (e.g. sickle-cell.jpg.json).
// Stripping the trailing .json gives us the served path component directly.
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg']);

interface BuildOpts {
  sidecarRoot: string;
  outFile: string;
}
interface BuildStats { entries: number; warnings: string[] }

export type ImageIndexModeName = 'database' | 'offline' | 'release';

export interface ImageIndexMode {
  name: ImageIndexModeName;
  requireSidecars: boolean;
}

export function resolveImageIndexMode(
  env: Record<string, string | undefined>,
): ImageIndexMode {
  const requested = env.MD3_GENERATED_CONTENT_MODE;
  if (requested === undefined || requested === '' || requested === 'database') {
    return { name: 'database', requireSidecars: true };
  }
  if (requested === 'offline') return { name: 'offline', requireSidecars: false };
  if (requested === 'release') return { name: 'release', requireSidecars: true };
  throw new Error(
    `[images:index] Invalid MD3_GENERATED_CONTENT_MODE=${JSON.stringify(requested)}. `
    + 'Expected "offline", "database", or "release".',
  );
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** True when the filename encodes an image extension before the final .json. */
function isSidecar(filePath: string): boolean {
  if (!filePath.endsWith('.json')) return false;
  const withoutJson = filePath.slice(0, -5); // strip .json
  const innerExt = withoutJson.slice(withoutJson.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXT.has(innerExt);
}

export function buildIndex(opts: BuildOpts): BuildStats {
  const warnings: string[] = [];
  const entries: Record<string, ImageSidecar> = {};

  if (!existsSync(opts.sidecarRoot)) {
    throw new Error(
      `[images:index] sidecar source not found: ${opts.sidecarRoot}\n` +
      `figure-sidecars/ must be committed in the md3 repo root for Vercel builds.\n` +
      `Run: cp -r <medicine-data>/figure-sidecars ./figure-sidecars && git add figure-sidecars`,
    );
  }

  // Walk *.<image-ext>.json sidecars; strip .json to get the served path.
  for (const path of walk(opts.sidecarRoot)) {
    if (!isSidecar(path)) continue;

    let sidecar: ImageSidecar;
    try {
      sidecar = JSON.parse(readFileSync(path, 'utf-8')) as ImageSidecar;
    } catch {
      warnings.push(`unreadable sidecar: ${path}`);
      continue;
    }
    const relWithJson = relative(opts.sidecarRoot, path).split(sep).join('/');
    const rel = relWithJson.slice(0, -5); // strip trailing .json
    entries[`/figures/${rel}`] = sidecar;
  }

  // Merge consolidated bulk sidecar maps (e.g. figure-sidecars/anking.bulk.json),
  // each a single `{ "/figures/…": { …sidecar } }` file. Used for large,
  // same-shape image sets (AnKing note media) so thousands of tiny per-image
  // sidecar files don't push the repo past Vercel's deployment file-count limit.
  for (const path of walk(opts.sidecarRoot)) {
    if (!path.endsWith('.bulk.json')) continue;
    try {
      const map = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, ImageSidecar>;
      for (const [key, sc] of Object.entries(map)) entries[key] = sc;
    } catch {
      warnings.push(`unreadable bulk sidecar map: ${path}`);
    }
  }

  const stableEntries = Object.fromEntries(
    Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)),
  );
  const body = JSON.stringify(stableEntries, null, 2) + '\n';
  mkdirSync(dirname(opts.outFile), { recursive: true });
  writeFileSync(opts.outFile, body, 'utf-8');

  return { entries: Object.keys(stableEntries).length, warnings };
}

export function buildIndexForMode(
  opts: BuildOpts,
  mode: ImageIndexMode,
): BuildStats {
  if (mode.requireSidecars) return buildIndex(opts);
  mkdirSync(dirname(opts.outFile), { recursive: true });
  writeFileSync(opts.outFile, '{}\n', 'utf-8');
  return { entries: 0, warnings: [] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd();
  // Sidecars are committed in md3 repo root (figure-sidecars/) so Vercel CI
  // can read them without cloning medicine-data. Hard-fail if missing.
  const sidecarRoot = join(root, 'figure-sidecars');
  let stats: BuildStats;
  try {
    const mode = resolveImageIndexMode(process.env);
    stats = buildIndexForMode({
      sidecarRoot,
      outFile: join(root, 'src', 'data', 'image-library.generated.json'),
    }, mode);
    console.log(`[images:index] mode=${mode.name}`);
  } catch (err) {
    console.error(String(err));
    process.exit(1);
  }
  console.log(`[images:index] ${stats.entries} entries`);
  for (const w of stats.warnings) console.warn(`[images:index] ${w}`);
}
