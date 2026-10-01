#!/usr/bin/env npx tsx
/**
 * Fail if the FOSS distribution is not import-closed.
 *
 *   npm run foss:boundary:imports                       # export to a temp dir, check it
 *   npm run foss:boundary:imports -- --artifact <dir>   # check an existing export
 *
 * The subject is the EXPORTED ARTIFACT, never `foss/distribution-paths.txt`.
 * The exporter also writes public replacements declared in
 * `foss/distribution-policy.json` (Navigation.tsx, personal-deck-owners and
 * others), whose content — and therefore whose imports — differ from the
 * private file at the same path. Checking the private tree would both miss
 * those files and read the wrong imports for them.
 *
 * See scripts/foss/import-closure.ts for why the file-selection audit cannot
 * catch this on its own.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { exportDistribution, loadDistributionPolicy } from './distribution';
import { findUnresolvedImports, summarise } from './import-closure';

const ROOT = join(__dirname, '..', '..');
const EXPORT_MANIFEST = 'FOSS-DISTRIBUTION-MANIFEST.json';

function artifactPaths(artifactDir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(artifactDir, EXPORT_MANIFEST), 'utf8')) as {
    files: Array<{ path: string }>;
  };
  return manifest.files.map((file) => file.path);
}

function check(artifactDir: string): boolean {
  const paths = artifactPaths(artifactDir);
  const problems = findUnresolvedImports(paths, artifactDir);

  if (problems.length === 0) {
    console.log(
      `FOSS import closure PASS: ${paths.length} artifact file(s), every @/ and relative import resolves inside the distribution`,
    );
    return true;
  }

  const byTarget = summarise(problems);
  console.error(
    `FOSS import closure FAIL: ${byTarget.size} module(s) imported by distributed files are not distributed\n`,
  );
  for (const [target, importers] of byTarget) {
    console.error(`  ${target}  (${importers.length} importer${importers.length === 1 ? '' : 's'})`);
    for (const importer of importers.slice(0, 4)) console.error(`      ← ${importer}`);
    if (importers.length > 4) console.error(`      … and ${importers.length - 4} more`);
  }
  console.error(
    '\nEach one is a decision, not a mechanical fix: either the module belongs in the'
    + '\npublic product (add it to the policy) or its importer does not (exclude that).'
    + '\nDo not resolve these by adding files without reading what they expose.',
  );
  return false;
}

function main(): void {
  const flag = process.argv.indexOf('--artifact');
  if (flag !== -1) {
    const dir = process.argv[flag + 1];
    if (!dir) throw new Error('--artifact needs a directory');
    if (!check(resolve(dir))) process.exitCode = 1;
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'md3-foss-closure-'));
  try {
    const artifactDir = join(scratch, 'artifact');
    exportDistribution(ROOT, loadDistributionPolicy(ROOT), artifactDir);
    if (!check(artifactDir)) process.exitCode = 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main();
