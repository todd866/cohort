import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  exportedSymbols,
  findRewriteClosureGaps,
  namedImportsFrom,
} from './generated-rewrite-closure';

const REWRITE_BEFORE = `
export const SCHEDULED_ROTATIONS = {};
export function unreachableRotations(a) { return a; }
`;
const REWRITE_AFTER = `${REWRITE_BEFORE}
export function defaultPrimaryRotation(scheduled) { return scheduled[0]; }
`;
const IMPORTER = `
import { SCHEDULED_ROTATIONS, defaultPrimaryRotation } from '@/lib/institution-rotations';
`;

describe('exportedSymbols', () => {
  it('collects declaration and braced exports', () => {
    const found = exportedSymbols(`
      export const A = 1;
      export function B() {}
      export interface C {}
      export type D = string;
      const e = 2;
      export { e as E };
    `);
    expect([...found].sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
  });
});

describe('namedImportsFrom', () => {
  it('reads named bindings from the matching module only', () => {
    expect(namedImportsFrom(IMPORTER, '@/lib/institution-rotations'))
      .toEqual(['SCHEDULED_ROTATIONS', 'defaultPrimaryRotation']);
    expect(namedImportsFrom(IMPORTER, '@/lib/other')).toEqual([]);
  });

  it('ignores type-only imports, which the artifact erases', () => {
    const src = "import type { Institution } from '@/lib/institution';";
    expect(namedImportsFrom(src, '@/lib/institution')).toEqual([]);
  });
});

describe('findRewriteClosureGaps', () => {
  // The exact 2026-08-21 break, reproduced.
  it('flags a symbol an exported source imports that the rewrite lacks', () => {
    const gaps = findRewriteClosureGaps(
      [{ path: 'src/lib/institution-rotations.ts', text: REWRITE_BEFORE }],
      [{ path: 'src/lib/review/server-bootstrap.ts', text: IMPORTER }],
    );
    expect(gaps).toEqual([{
      importer: 'src/lib/review/server-bootstrap.ts',
      module: 'src/lib/institution-rotations.ts',
      symbol: 'defaultPrimaryRotation',
    }]);
  });

  it('is clean once the rewrite grows the symbol', () => {
    expect(findRewriteClosureGaps(
      [{ path: 'src/lib/institution-rotations.ts', text: REWRITE_AFTER }],
      [{ path: 'src/lib/review/server-bootstrap.ts', text: IMPORTER }],
    )).toEqual([]);
  });
});

// The gate. Runs against the real policy and the real reviewed path list, so a
// privately-added symbol that an exported source imports fails here — in
// milliseconds — instead of in CI's clean-artifact build.
describe('the committed FOSS rewrites', () => {
  it('export every symbol the exported sources import from them', () => {
    const root = process.cwd();
    const policy = JSON.parse(
      fs.readFileSync(path.join(root, 'foss', 'distribution-policy.json'), 'utf8'),
    ) as { generatedTextFiles: Array<{ path: string; text: string }> };
    const rewrites = policy.generatedTextFiles.filter((f) => /\.tsx?$/.test(f.path));

    const exportedPaths = fs
      .readFileSync(path.join(root, 'foss', 'distribution-paths.txt'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /\.tsx?$/.test(line) && !line.endsWith('.test.ts') && !line.endsWith('.test.tsx'));

    const exportedSources = exportedPaths
      .filter((p) => fs.existsSync(path.join(root, p)))
      .map((p) => ({ path: p, text: fs.readFileSync(path.join(root, p), 'utf8') }));

    expect(exportedSources.length).toBeGreaterThan(50); // guard against reading nothing
    expect(findRewriteClosureGaps(rewrites, exportedSources)).toEqual([]);
  });
});
