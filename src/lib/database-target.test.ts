import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDatabaseTarget } from './database-target';

describe('shared database target resolution', () => {
  it('uses the configured database when the local override is unset or empty', () => {
    expect(resolveDatabaseTarget({ DATABASE_URL: 'postgresql://configured' })).toEqual({
      name: 'configured-database',
      connectionString: 'postgresql://configured',
    });
    expect(resolveDatabaseTarget({
      DATABASE_URL: 'postgresql://configured',
      DATABASE_URL_LOCAL: '',
    })).toEqual({
      name: 'configured-database',
      connectionString: 'postgresql://configured',
    });
  });

  it('uses a non-empty local override without exposing either URL in the target label', () => {
    const resolved = resolveDatabaseTarget({
      DATABASE_URL: 'postgresql://configured',
      DATABASE_URL_LOCAL: 'postgresql://local',
    });

    expect(resolved).toEqual({
      name: 'local-mirror',
      connectionString: 'postgresql://local',
    });
    expect(resolved.name).not.toContain('postgresql://');
  });

  it('binds runtime readers and release generators to the same resolver', () => {
    const runtime = fs.readFileSync(path.resolve('src/lib/prisma.ts'), 'utf8');
    const generator = fs.readFileSync(path.resolve('scripts/lib/db.ts'), 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(runtime).toContain('resolveDatabaseTarget(process.env)');
    expect(generator).toContain('resolveDatabaseTarget(process.env)');
    expect(packageJson.scripts['build:release']).toContain('usmle:serving-db:preflight');
    expect(packageJson.scripts['build:release']).toContain(
      'MD3_GENERATED_CONTENT_MODE=release node --import tsx scripts/content/generate-content-map.ts',
    );
    expect(packageJson.scripts['build:release']).toContain(
      'MD3_GENERATED_CONTENT_MODE=release node --import tsx scripts/content/generate-starter-sessions.ts',
    );
  });

  it('announces the resolved target so mirror reads are never silently mistaken for production', () => {
    const generator = fs.readFileSync(path.resolve('scripts/lib/db.ts'), 'utf8');

    expect(generator).toContain('databaseConnection.provenance');
    expect(generator).toMatch(/console\.(error|warn)/);
    expect(generator).not.toMatch(/console\.\w+\([^)]*connectionString/);
  });

  it('pins production WRITE paths to the configured database', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    // A mirrored READ reports a stale number. A mirrored WRITE is worse: the
    // remediation appears to succeed, the diagnostic still reports the gap, and
    // the work lands on a laptop. `manifold:embed` is the documented fix for
    // stale embeddings while its own diagnostic (audit:embedding-coverage)
    // reads production, so the loop could never converge.
    const productionWrites = [
      'manifold:embed',
      'manifold:cluster',
      'manifold:subspaces',
      'courseware:embed',
      'citations:embed',
      // Imports a gated apkg manifest straight into Card. Mirrored, it would
      // report "4,843 created" while production stayed empty — and because
      // createMany(skipDuplicates) is idempotent, the re-run against the real
      // database would look identical, so the mistake leaves no trace.
      'anki:import:manifest',
      // The documented "upsert curated bank to Postgres" command. Mirrored on
      // 2026-08-26 it reported "Upserted 10310" while production gained
      // nothing — two new bank questions silently landed on a laptop.
      'questions:seed:bank',
      // Changed-files-only card/question seed (2026-09-07). Same hazard as
      // questions:seed:bank: a mirrored run reports success while production
      // keeps serving the uncorrected card.
      'seed:scoped',
      // Uploads a clip to the private video bucket and registers the row that
      // makes it servable. Mirrored, the object lands in R2 for real while the
      // VideoClip row lands on a laptop — so the media exists, nothing serves
      // it, and the orphan is invisible from production.
      'clips:cut',
    ];

    const present = productionWrites.filter((name) => packageJson.scripts[name]);
    if (present.length === 0) return;

    for (const name of present) {
      expect(packageJson.scripts[name], `${name} writes to the DB and must blank DATABASE_URL_LOCAL`)
        .toContain('DATABASE_URL_LOCAL=');
    }
  });

  it('pins production diagnostics to the configured database', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    // These read live state to describe production. A local-mirror fallback makes
    // them report stale numbers that look valid, which is how a morning check
    // reported zero engagement while production was healthy.
    const productionDiagnostics = [
      'stats',
      'stats:today',
      'scaffold:needs',
      'audit:image-gaps',
      'audit:image-improvement',
      'audit:tla-decode-gaps',
      'audit:tla-decode-queue',
      'audit:tla-decode-record',
      'audit:cloze-widen-gaps',
      'audit:teaching-alignment',
      'audit:concept-followup',
      'audit:exact-card-due',
      'audit:tutor',
      'audit:serving-path',
      'audit:orphan-cards',
      'audit:diagnose',
      'audit:trim-question-contexts',
      'audit:first-sight-transfer',
      'audit:overexposed-stems',
      'audit:serve-concentration',
      'audit:repetition-forecast',
      // Added 2026-08-12 after it silently read the mirror: the mirror listed
      // 4,235 imageless cards against production's 9,683, so a candidate set
      // built from it would have missed more than half the corpus AND risked
      // wiring figures onto cards that already had one.
      'images:visual:dump',
    ];

    // The FOSS public package deliberately omits private morning-check diagnostics.
    // When none of those scripts exist, this pin does not apply.
    const present = productionDiagnostics.filter((name) => packageJson.scripts[name]);
    if (present.length === 0) return;

    for (const name of present) {
      expect(packageJson.scripts[name], `${name} must blank DATABASE_URL_LOCAL`).toContain(
        'DATABASE_URL_LOCAL=',
      );
    }
    // Private tree must keep the full set — a missing script is a real regression.
    if (present.length !== productionDiagnostics.length) {
      expect(
        productionDiagnostics.filter((name) => !packageJson.scripts[name]),
        'private package is missing production diagnostic scripts',
      ).toEqual([]);
    }
  });
});
