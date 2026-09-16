#!/usr/bin/env npx tsx
/**
 * Fail if the FOSS distribution is not import-closed.
 *
 *   npm run foss:boundary:imports
 *
 * See scripts/foss/import-closure.ts for why the file-selection audit cannot
 * catch this on its own.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { findUnresolvedImports, summarise } from './import-closure';

const ROOT = join(__dirname, '..', '..');
const MANIFEST = join(ROOT, 'foss', 'distribution-paths.txt');

function main(): void {
  const paths = readFileSync(MANIFEST, 'utf8').split('\n').filter(Boolean);
  const problems = findUnresolvedImports(paths, ROOT);

  if (problems.length === 0) {
    console.log(`FOSS import closure PASS: ${paths.length} path(s), every @/ import resolves inside the distribution`);
    return;
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
  process.exitCode = 1;
}

main();
