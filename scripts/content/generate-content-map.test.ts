import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  assertGeneratedContentIsUsable,
  buildRotationSlugMap,
  contentMapDatabaseFailureAction,
  resolveGeneratedContentMode,
  toRotationSlug,
} from './generate-content-map';

describe('generated-content build modes', () => {
  it('uses a deterministic, database-free contract for ordinary code builds', () => {
    expect(resolveGeneratedContentMode({ MD3_GENERATED_CONTENT_MODE: 'offline' })).toEqual({
      name: 'offline',
      readDatabase: false,
      failOnDatabaseError: false,
      requireData: false,
      generatedAt: '1970-01-01T00:00:00.000Z',
    });
  });

  it('makes release generation database-backed and fail-closed', () => {
    const mode = resolveGeneratedContentMode({ MD3_GENERATED_CONTENT_MODE: 'release' });

    expect(mode.readDatabase).toBe(true);
    expect(mode.failOnDatabaseError).toBe(true);
    expect(mode.requireData).toBe(true);
    expect(() => assertGeneratedContentIsUsable(mode, 'content map', 0)).toThrow(
      /release mode requires non-empty content map/i,
    );
    expect(() => assertGeneratedContentIsUsable(mode, 'content map', 1)).not.toThrow();
  });

  it('never retains stale answer-bearing artifacts after a database failure', () => {
    expect(contentMapDatabaseFailureAction(
      resolveGeneratedContentMode({ MD3_GENERATED_CONTENT_MODE: 'release' }),
    )).toBe('throw');
    expect(contentMapDatabaseFailureAction(resolveGeneratedContentMode({}))).toBe('write-empty');
  });

  it('preserves the legacy direct-generator flags when no build mode is explicit', () => {
    expect(resolveGeneratedContentMode({})).toMatchObject({
      name: 'database',
      readDatabase: true,
      failOnDatabaseError: false,
      requireData: false,
    });
    expect(resolveGeneratedContentMode({ CONTENT_MAP_STRICT: '1' })).toMatchObject({
      name: 'database',
      failOnDatabaseError: true,
    });
    expect(resolveGeneratedContentMode({ CONTENT_MAP_REQUIRE_DATA: '1' })).toMatchObject({
      name: 'database',
      requireData: true,
    });
    expect(
      resolveGeneratedContentMode(
        { CONTENT_MAP_STRICT: '1', CONTENT_MAP_REQUIRE_DATA: '1' },
        { legacyContentMapFlags: false },
      ),
    ).toMatchObject({
      name: 'database',
      failOnDatabaseError: false,
      requireData: false,
    });
  });

  it('rejects misspelled modes instead of falling back to a permissive build', () => {
    expect(() => resolveGeneratedContentMode({ MD3_GENERATED_CONTENT_MODE: 'relese' })).toThrow(
      /MD3_GENERATED_CONTENT_MODE/i,
    );
  });

  it('routes code, CI, and deploy builds through their explicit safety contracts', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const vercel = JSON.parse(fs.readFileSync(path.resolve('vercel.json'), 'utf8')) as {
      buildCommand: string;
    };
    const workflow = fs.readFileSync(path.resolve('.github/workflows/ci.yml'), 'utf8');
    const internalReleaseScriptPath = path.resolve('scripts/ops/release-green-commit.mjs');
    const internalReleaseScript = fs.existsSync(internalReleaseScriptPath)
      ? fs.readFileSync(internalReleaseScriptPath, 'utf8')
      : null;

    expect(packageJson.scripts.build).toContain('MD3_GENERATED_CONTENT_MODE=offline');
    expect(packageJson.scripts['build:release']).toContain('MD3_GENERATED_CONTENT_MODE=release');
    expect(packageJson.scripts['build:release']).toContain(
      'npm run usmle:corpus:release-gate',
    );
    expect(packageJson.scripts['build:isolated:release']).toContain(
      'MD3_GENERATED_CONTENT_MODE=release',
    );
    expect(packageJson.scripts['build:isolated:release']).toContain(
      'npm run usmle:corpus:release-gate',
    );
    expect(vercel.buildCommand).toBe('npm run build:release');
    expect(workflow).toMatch(/MD3_GENERATED_CONTENT_MODE:\s*['"]?offline['"]?/);
    expect(workflow).toContain('run: npm run usmle:corpus:release-gate');
    expect(workflow).not.toContain('CONTENT_MAP_STRICT');
    // The private operator-only release helper is intentionally absent from
    // the FOSS artifact. Assert its contract when present in the source repo;
    // the public package/workflow/vercel contracts above remain unconditional.
    if (internalReleaseScript !== null) {
      expect(internalReleaseScript).toContain("MD3_GENERATED_CONTENT_MODE: 'release'");
      expect(internalReleaseScript).toContain(
        "run('npm', ['run', 'build:release'], { env: productionDbEnv })",
      );
    }
  });
});

describe('rotation-counts generation', () => {
  it('normalizes rotation names into filesystem-safe slugs', () => {
    expect(toRotationSlug('Critical Care')).toBe('critical_care');
    expect(toRotationSlug('USMLE-Cardio')).toBe('usmle-cardio');
    expect(toRotationSlug('PAAM/Week 1')).toBe('paam_week_1');
  });

  it('throws on slug collisions across different rotations', () => {
    expect(() => buildRotationSlugMap(['Critical Care', 'Critical@Care'])).toThrow(
      /Rotation slug collision/,
    );
  });

  it('exports ROTATION_COUNTS as a Record<string, number>', async () => {
    const { ROTATION_COUNTS } = await import('../../src/lib/generated/rotation-counts');
    expect(typeof ROTATION_COUNTS).toBe('object');
    const keys = Object.keys(ROTATION_COUNTS);
    // CI generates empty maps (no DB) — only assert structure when data exists
    if (keys.length > 0) {
      for (const value of Object.values(ROTATION_COUNTS)) {
        expect(typeof value).toBe('number');
        expect(value).toBeGreaterThan(0);
      }
    }
  });

  it('threads imageCaption through both StaticCard and StaticQuestion at every step of the script', () => {
    // Read the generator source itself rather than the generated artifact.
    // src/lib/generated/ is gitignored, so an artifact-based test silently
    // passes in any environment where the file is missing or stale. The
    // script source is the actual contract, so assert against it directly.
    const scriptPath = path.resolve(__dirname, 'generate-content-map.ts');
    const src = fs.readFileSync(scriptPath, 'utf8');

    const cardInterface = src.match(/interface StaticCard \{[\s\S]*?\}/)?.[0] ?? '';
    const questionInterface = src.match(/interface StaticQuestion \{[\s\S]*?\}/)?.[0] ?? '';
    expect(cardInterface).toMatch(/imageCaption:/);
    expect(questionInterface).toMatch(/imageCaption:/);

    // Both Prisma selects must request imageCaption.
    const selectBlocks = src.match(/select:\s*\{[\s\S]*?\}/g) ?? [];
    const topLevelSelects = selectBlocks.filter((s) => s.includes('imageUrl: true'));
    expect(topLevelSelects.length).toBeGreaterThanOrEqual(2);
    for (const block of topLevelSelects) {
      expect(block).toContain('imageCaption: true');
    }

    // Normalize blocks for cards and questions both forward imageCaption.
    expect(src).toMatch(/imageCaption:\s*card\.imageCaption\s*\?\?\s*null/);
    expect(src).toMatch(/imageCaption:\s*question\.imageCaption\s*\?\?\s*null/);

    // Emitted type definitions include imageCaption for both interfaces.
    const emittedImageCaption = src.match(/typeLines\.push\(['"]\s*imageCaption: string \| null;['"]\)/g) ?? [];
    expect(emittedImageCaption.length).toBe(2);
  });

  it('threads cloze variant fields (variantGroupId/variantIndex/variantType) through StaticCard at every step of the script', () => {
    // Same pattern as the imageCaption test above: assert the script source
    // (the contract) carries the variant fields end-to-end. Generated
    // artifacts are gitignored, so artifact-based assertions are unreliable.
    const scriptPath = path.resolve(__dirname, 'generate-content-map.ts');
    const src = fs.readFileSync(scriptPath, 'utf8');

    // The internal StaticCard interface declares all three variant fields.
    const cardInterface = src.match(/interface StaticCard \{[\s\S]*?\}/)?.[0] ?? '';
    expect(cardInterface).toMatch(/variantGroupId:/);
    expect(cardInterface).toMatch(/variantIndex:/);
    expect(cardInterface).toMatch(/variantType:/);

    // The Card prisma select requests all three fields.
    const selectBlocks = src.match(/select:\s*\{[\s\S]*?\}/g) ?? [];
    const cardSelect = selectBlocks.find(
      (s) => s.includes('imageUrl: true') && s.includes('cardType: true'),
    );
    expect(cardSelect, 'card prisma select block').toBeDefined();
    expect(cardSelect).toContain('variantGroupId: true');
    expect(cardSelect).toContain('variantIndex: true');
    expect(cardSelect).toContain('variantType: true');

    // Normalize block forwards each variant field with `?? null`.
    expect(src).toMatch(/variantGroupId:\s*card\.variantGroupId\s*\?\?\s*null/);
    expect(src).toMatch(/variantIndex:\s*card\.variantIndex\s*\?\?\s*null/);
    expect(src).toMatch(/variantType:\s*card\.variantType\s*\?\?\s*null/);

    // Emitted StaticCard type carries all three fields.
    expect(src).toMatch(/typeLines\.push\(['"]\s*variantGroupId: string \| null;['"]\)/);
    expect(src).toMatch(/typeLines\.push\(['"]\s*variantIndex: number \| null;['"]\)/);
    expect(src).toMatch(/typeLines\.push\(['"]\s*variantType: string \| null;['"]\)/);
  });

  it('keeps raw public-USMLE questions out of generated legacy content maps', () => {
    const scriptPath = path.resolve(__dirname, 'generate-content-map.ts');
    const src = fs.readFileSync(scriptPath, 'utf8');

    expect(src).toContain("import { withoutRawPublicUsmleQuestions } from '../../src/lib/usmle/raw-question-boundary';");
    expect(src).toMatch(
      /prisma\.question\.findMany\(\{\s*where:\s*withoutRawPublicUsmleQuestions\(\{[\s\S]*?excluded:\s*false[\s\S]*?rotation:\s*\{\s*notIn:\s*EXCLUDED_FROM_MAP\s*\}[\s\S]*?\}\),/,
    );
    const questionInterface = src.match(/interface StaticQuestion \{[\s\S]*?\}/)?.[0] ?? '';
    expect(questionInterface).toMatch(/moduleNodes:/);
    expect(src).toMatch(/rotation:\s*true,\s*moduleNodes:\s*true,/);
    expect(src).toMatch(/moduleNodes:\s*question\.moduleNodes\s*\?\?\s*\[\]/);
    expect(src).toMatch(/typeLines\.push\(['"]\s*moduleNodes: string\[\];['"]\)/);
  });

  it('keeps public-USMLE question-reinforcement cards out of generated legacy maps', () => {
    const scriptPath = path.resolve(__dirname, 'generate-content-map.ts');
    const src = fs.readFileSync(scriptPath, 'utf8');

    expect(src).toContain(
      "import { withoutRawPublicUsmleReinforcementCards } from '../../src/lib/usmle/raw-reinforcement-card-boundary';",
    );
    expect(src).toMatch(
      /prisma\.card\.findMany\(\{\s*where:\s*withoutRawPublicUsmleReinforcementCards\(\{[\s\S]*?deletedAt:\s*null[\s\S]*?rotation:\s*\{\s*notIn:\s*EXCLUDED_FROM_MAP\s*\}[\s\S]*?\}\),/,
    );
    expect(src).toMatch(
      /cards\s*=\s*await filterDeliverableReinforcementCardRows\(cards,\s*\{[\s\S]*?client:\s*prisma,[\s\S]*?transport:\s*'generated-content-map'/,
    );
  });

  it('exports rotation shard loaders for each available rotation', async () => {
    const { ROTATION_CONTENT_LOADERS, AVAILABLE_ROTATIONS } = await import(
      '../../src/lib/generated/content-map-rotations'
    );
    const keys = Object.keys(ROTATION_CONTENT_LOADERS);
    expect(keys.sort()).toEqual([...AVAILABLE_ROTATIONS].sort());

    // Spot-check one loader when data exists (CI has no DB so maps are empty).
    // Use the loader keys so the empty generated tuple in CI does not collapse
    // the indexed rotation type to `undefined`.
    const sampleRotation = keys[0];
    if (sampleRotation) {
      const sample = await ROTATION_CONTENT_LOADERS[sampleRotation]();
      expect(sample).toHaveProperty('cards');
      expect(sample).toHaveProperty('questions');
    }
  }, 15_000);
});
