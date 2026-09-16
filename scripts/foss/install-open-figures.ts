#!/usr/bin/env npx tsx
/**
 * Copy the openly-licensed Step 1 diagrams into the served static path.
 *
 *   npm run usmle:figures:install
 *
 * Why this exists. 345 of the 556 released Step 1 questions carry an
 * `imageUrl` of `/figures/usmle/step1/<asset>.svg`, but `public/figures` is a
 * FORBIDDEN prefix in the distribution policy — that tree holds 623
 * rights-managed files, and the boundary is deliberately fail-closed over the
 * whole directory rather than per-file. So the exported artifact ships these 55
 * CC BY 4.0 SVGs at their canonical open-corpus location
 * (`open-content/usmle/step1/media/`) and nothing renders until they are
 * installed here.
 *
 * In the private checkout `wire-open-figure.ts` already writes both copies, so
 * this is a no-op; it is the FOSS clone that needs it. Idempotent either way.
 *
 * Only assets that `isOpenFigurePath` accepts are copied, so this can never
 * promote a rights-managed file into the public namespace.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPEN_FIGURE_PREFIX, isOpenFigurePath } from '../../src/lib/figures/open-figure-access';

const ROOT = join(__dirname, '..', '..');
const MEDIA = join(ROOT, 'open-content', 'usmle', 'step1', 'media');
const PUBLIC = join(ROOT, 'public', ...OPEN_FIGURE_PREFIX.split('/').filter(Boolean));

function main(): void {
  if (!existsSync(MEDIA)) {
    console.error(`[usmle:figures] open corpus media not found: ${MEDIA}`);
    process.exitCode = 1;
    return;
  }

  mkdirSync(PUBLIC, { recursive: true });

  let copied = 0;
  let unchanged = 0;
  let refused = 0;

  for (const name of readdirSync(MEDIA).sort()) {
    if (!name.endsWith('.svg')) continue;
    if (!isOpenFigurePath(`${OPEN_FIGURE_PREFIX}${name}`)) {
      console.warn(`[usmle:figures] refused (not an open-corpus asset name): ${name}`);
      refused += 1;
      continue;
    }

    const source = join(MEDIA, name);
    const target = join(PUBLIC, name);
    if (existsSync(target) && readFileSync(target).equals(readFileSync(source))) {
      unchanged += 1;
      continue;
    }
    copyFileSync(source, target);
    copied += 1;
  }

  console.log(
    `[usmle:figures] ${copied} copied, ${unchanged} already current`
    + (refused ? `, ${refused} refused` : ''),
  );
}

main();
