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
});
