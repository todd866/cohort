import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDistributionPolicy } from './distribution';

function matchesPrefix(filePath: string, prefix: string): boolean {
  return filePath === prefix || filePath.startsWith(`${prefix}/`);
}

function isSelectedTest(
  filePath: string,
  policy: ReturnType<typeof loadDistributionPolicy>,
): boolean {
  const explicitlyIncluded = policy.includeFiles.includes(filePath);
  const included = explicitlyIncluded
    || policy.includeRoots.some((root) => matchesPrefix(filePath, root));
  const excluded = policy.excludeFiles.includes(filePath)
    || policy.excludePrefixes.some((prefix) => matchesPrefix(filePath, prefix));
  return included && explicitlyIncluded && !excluded;
}

function testFilesUnder(repoRoot: string, relativeRoot: string): string[] {
  const files: string[] = [];
  const walk = (relativeDirectory: string): void => {
    const absoluteDirectory = path.join(repoRoot, relativeDirectory);
    if (!fs.existsSync(absoluteDirectory)) return;
    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relative = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) walk(relative);
      else if (entry.isFile() && /\.test\.tsx?$/.test(relative)) files.push(relative);
    }
  };
  walk(relativeRoot);
  return files.sort();
}

describe('FOSS USMLE test surface', () => {
  it('runs every distributable USMLE library, ingestion, API, and UI test', () => {
    const repoRoot = process.cwd();
    const policy = loadDistributionPolicy(repoRoot);
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { scripts?: { 'foss:test'?: string } };
    const command = packageJson.scripts?.['foss:test'] ?? '';
    const selectedTests = [
      ...testFilesUnder(repoRoot, 'src/lib/usmle'),
      ...testFilesUnder(repoRoot, 'src/lib/question-bank').filter((filePath) => (
        /\b(?:openUsmle|publicUsmle|usmle)\b/i.test(
          fs.readFileSync(path.join(repoRoot, filePath), 'utf8'),
        )
      )),
      ...testFilesUnder(repoRoot, 'src/app/api/usmle'),
      ...testFilesUnder(repoRoot, 'src/app/usmle'),
    ].filter((filePath) => isSelectedTest(filePath, policy));
    const missing = selectedTests.filter((filePath) => !command.includes(filePath));

    expect(missing, `foss:test omits distributable tests: ${missing.join(', ')}`).toEqual([]);
  });

  it('runs every test deliberately selected for the public artifact', () => {
    const repoRoot = process.cwd();
    const policy = loadDistributionPolicy(repoRoot);
    const generatedPackage = policy.generatedTextFiles.find(
      (file) => file.path === 'package.json',
    );
    expect(generatedPackage).toBeDefined();
    const packageJson = JSON.parse(generatedPackage!.text) as {
      scripts?: Record<string, string>;
    };
    const command = packageJson.scripts?.['foss:test'] ?? '';
    const invokedTests = new Set(
      [...command.matchAll(/(?:^|\s)["']?([^\s"']+\.test\.tsx?)["']?/g)]
        .map((match) => match[1]),
    );
    const selectedTests = policy.includeFiles.filter((filePath) => /\.test\.tsx?$/.test(filePath));

    expect(
      selectedTests.filter((filePath) => !invokedTests.has(filePath)),
      'selected public tests missing from foss:test',
    ).toEqual([]);
    expect(
      [...invokedTests].filter((filePath) => !selectedTests.includes(filePath)),
      'foss:test references tests outside the reviewed public boundary',
    ).toEqual([]);
  });

  it('ships every relative import used by advertised database wrappers', () => {
    const repoRoot = process.cwd();
    const policy = loadDistributionPolicy(repoRoot);
    const generatedPackage = policy.generatedTextFiles.find(
      (file) => file.path === 'package.json',
    );
    expect(generatedPackage).toBeDefined();
    const packageJson = JSON.parse(generatedPackage!.text) as {
      scripts?: Record<string, string>;
    };
    const dbCommands = Object.entries(packageJson.scripts ?? {})
      .filter(([name]) => name.startsWith('db:'))
      .map(([, command]) => command);
    const wrappers = new Set<string>();
    for (const command of dbCommands) {
      for (const match of command.matchAll(/\b(scripts\/db\/[A-Za-z0-9._/-]+\.(?:mjs|js|ts))\b/g)) {
        wrappers.add(match[1]);
      }
    }

    expect([...wrappers].sort()).toContain('scripts/db/prisma-with-env.mjs');
    const artifactPaths = new Set([
      ...fs.readFileSync(path.join(repoRoot, policy.pathManifest), 'utf8')
        .split('\n')
        .filter(Boolean),
      ...policy.generatedTextFiles.map((file) => file.path),
    ]);

    for (const wrapper of wrappers) {
      expect(artifactPaths.has(wrapper), `${wrapper} is advertised but not exported`).toBe(true);
      const source = fs.readFileSync(path.join(repoRoot, wrapper), 'utf8');
      const relativeImports = [...source.matchAll(
        /(?:\bfrom\s+|\bimport\s*)['"](\.[^'"]+)['"]/g,
      )].map((match) => match[1]);
      for (const specifier of relativeImports) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(wrapper), specifier));
        expect(
          artifactPaths.has(resolved),
          `${wrapper} imports ${specifier}, but ${resolved} is not exported`,
        ).toBe(true);
        expect(fs.existsSync(path.join(repoRoot, resolved))).toBe(true);
      }
    }
  });

  it('hydrates operator env files consistently before every advertised live database entrypoint', () => {
    const repoRoot = process.cwd();
    const policy = loadDistributionPolicy(repoRoot);
    const generatedPackage = policy.generatedTextFiles.find(
      (file) => file.path === 'package.json',
    );
    expect(generatedPackage).toBeDefined();
    const packageJson = JSON.parse(generatedPackage!.text) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};

    for (const [name, command] of Object.entries(scripts).filter(([name]) => name.startsWith('db:'))) {
      if (name === 'db:seed:usmle-open') {
        expect(command).toContain('scripts/usmle/seed-open-corpus.ts');
      } else {
        expect(command, `${name} must use the env-hydrating Prisma wrapper`).toContain(
          'scripts/db/prisma-with-env.mjs',
        );
      }
    }

    const envAwareEntrypoints = [
      {
        path: 'scripts/db/prisma-with-env.mjs',
        before: 'spawnSync(prismaBin',
      },
      {
        path: 'scripts/usmle/seed-open-corpus.ts',
        before: "await import('../../src/lib/prisma')",
      },
      {
        path: 'scripts/usmle/check-serving-db.ts',
        before: "await import('../../src/lib/prisma')",
      },
      {
        path: 'scripts/usmle/repair-protected-reinforcement-cards.ts',
        before: "await import('../../src/lib/prisma')",
      },
    ];
    for (const entrypoint of envAwareEntrypoints) {
      const source = fs.readFileSync(path.join(repoRoot, entrypoint.path), 'utf8');
      const localEnv = source.indexOf('.env.local');
      const fallbackEnv = source.indexOf("'.env'");
      const databaseUse = source.indexOf(entrypoint.before);
      expect(localEnv, `${entrypoint.path} must load .env.local`).toBeGreaterThanOrEqual(0);
      expect(fallbackEnv, `${entrypoint.path} must load .env`).toBeGreaterThan(localEnv);
      expect(databaseUse, `${entrypoint.path} must load env before database use`).toBeGreaterThan(
        fallbackEnv,
      );
    }

    expect(scripts['usmle:serving-db:preflight']).toContain('scripts/usmle/check-serving-db.ts');
    expect(scripts['usmle:reinforcement:audit']).toContain(
      'scripts/usmle/repair-protected-reinforcement-cards.ts',
    );
    expect(scripts['usmle:reinforcement:repair:apply']).toContain(
      'scripts/usmle/repair-protected-reinforcement-cards.ts --apply',
    );
  });
});
