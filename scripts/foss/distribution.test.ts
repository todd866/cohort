import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  PUBLIC_API_ROUTE_PATHS,
  PUBLIC_APP_HANDLER_ROUTE_PATHS,
  PUBLIC_APP_SHELL_PATHS,
  PUBLIC_METADATA_ROUTE_PATHS,
  PUBLIC_PAGE_ROUTE_PATHS,
  PROTECTED_PUBLIC_FALLBACKS,
  auditDistributionBoundary,
  exportDistribution,
  loadDistributionPolicy,
  parseDistributionArgs,
  writeReviewedPathManifest,
} from './distribution';

const temporaryRoots: string[] = [];

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md3-foss-boundary-test-'));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.mkdirSync(path.join(root, 'open-content/usmle/step1'), { recursive: true });
  fs.mkdirSync(path.join(root, 'foss'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app/index.ts'), 'export const value = 1;\n');
  fs.writeFileSync(
    path.join(root, 'open-content/usmle/step1/item.json'),
    '{"licence":"CC-BY-4.0"}\n',
  );
  fs.writeFileSync(
    path.join(root, 'open-content/usmle/step1/sources.json'),
    `${JSON.stringify({
      sources: [
        {
          id: 'government-source',
          canonicalUrl: 'https://example.gov/source',
          attribution: 'U.S. Government fixture',
          licence: {
            cls: 'foss',
            id: 'us-gov',
            url: 'https://example.gov/rights',
          },
          passages: [{
            id: 'government-passage',
            locator: 'Fixture section',
            quote: 'An exact government fixture passage.',
          }],
        },
        {
          id: 'cc-source',
          canonicalUrl: 'https://example.org/source',
          attribution: 'CC BY fixture',
          licence: {
            cls: 'foss',
            id: 'cc-by-4.0',
            url: 'https://creativecommons.org/licenses/by/4.0/',
          },
          passages: [{
            id: 'cc-passage',
            locator: 'Fixture section',
            quote: 'An exact Creative Commons fixture passage.',
          }],
        },
      ],
    })}\n`,
  );
  fs.writeFileSync(path.join(root, 'LICENSE'), 'MIT fixture\n');
  fs.writeFileSync(path.join(root, 'foss/distribution-paths.txt'), '');
  fs.writeFileSync(path.join(root, 'foss/distribution-policy.json'), `${JSON.stringify({
    schemaVersion: 1,
    pathManifest: 'foss/distribution-paths.txt',
    includeRoots: ['app', 'open-content/usmle/step1'],
    includeFiles: [
      'LICENSE',
      'foss/distribution-paths.txt',
      'foss/distribution-policy.json',
    ],
    excludePrefixes: [],
    excludeFiles: ['app/generated-fallback.json'],
    forbiddenPrefixes: ['content', 'question-bank', 'audit', 'data'],
    allowedTextExtensions: ['', '.css', '.json', '.md', '.mjs', '.prisma', '.sh', '.sql', '.ts', '.tsx', '.txt'],
    allowedBinaryFiles: [],
    licenceOverrides: [{
      path: 'open-content/usmle/step1/sources.json',
      licence: 'MIXED-PER-SOURCE',
    }],
    generatedTextFiles: [{
      path: 'app/generated-fallback.json',
      text: '{}\n',
      licence: 'MIT',
    }],
    maximumFileBytes: 1_000_000,
  }, null, 2)}\n`);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('FOSS distribution boundary', () => {
  it('limits source-tree mode to non-mutating audits', () => {
    expect(parseDistributionArgs(['--source-tree', '--json'])).toEqual({
      action: 'audit',
      exportPath: null,
      json: true,
      sourceTree: true,
    });
    expect(() => parseDistributionArgs(['--source-tree', '--write-paths']))
      .toThrow(/valid only for an audit/i);
    expect(() => parseDistributionArgs(['--source-tree', '--export', '/tmp/export']))
      .toThrow(/valid only for an audit/i);
  });

  it('audits a reviewed manifest and classifies only the open corpus as content', () => {
    const root = fixture();
    const policy = loadDistributionPolicy(root);
    writeReviewedPathManifest(root, policy);

    const report = auditDistributionBoundary(root, policy);

    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.fileCount).toBe(7);
    expect(report.licenseCounts).toEqual({
      'CC-BY-4.0': 1,
      MIT: 5,
      'MIXED-PER-SOURCE': 1,
    });
  });

  it('atomically replaces the reviewed path lock without leaving a temp file', () => {
    const root = fixture();
    const policy = loadDistributionPolicy(root);
    const lockPath = path.join(root, policy.pathManifest);
    fs.writeFileSync(lockPath, 'stale/path.ts\n');

    const report = writeReviewedPathManifest(root, policy);

    expect(report.ok).toBe(true);
    expect(fs.readFileSync(lockPath, 'utf8')).toContain('app/index.ts\n');
    expect(
      fs.readdirSync(path.dirname(lockPath))
        .filter((name) => name.startsWith(`.${path.basename(lockPath)}.tmp-`)),
    ).toEqual([]);
  });

  it('refreshes a public source lock even when its embedded export manifest is stale', () => {
    const root = fixture();
    const policy = loadDistributionPolicy(root);
    writeReviewedPathManifest(root, policy);
    const output = path.join(
      os.tmpdir(),
      `md3-foss-stale-manifest-write-${process.pid}-${Date.now()}`,
    );
    temporaryRoots.push(output);
    exportDistribution(root, policy, output);
    fs.writeFileSync(path.join(output, 'app/new.ts'), 'export const added = true;\n');
    const exportedPolicy = loadDistributionPolicy(output);

    const report = writeReviewedPathManifest(output, exportedPolicy);

    expect(report.ok).toBe(true);
    expect(fs.readFileSync(path.join(output, exportedPolicy.pathManifest), 'utf8'))
      .toContain('app/new.ts\n');
    expect(auditDistributionBoundary(output, exportedPolicy, {
      verifyExistingExportManifest: false,
    }).ok).toBe(true);
    expect(auditDistributionBoundary(output, exportedPolicy).issues).toContainEqual(
      expect.objectContaining({ code: 'export-manifest-mismatch' }),
    );
  });

  it('re-exports a stale public source only after a new candidate enters the path lock', () => {
    const root = fixture();
    const policy = loadDistributionPolicy(root);
    writeReviewedPathManifest(root, policy);
    const published = path.join(
      os.tmpdir(),
      `md3-foss-published-source-${process.pid}-${Date.now()}`,
    );
    const refreshed = `${published}-refreshed`;
    temporaryRoots.push(published, refreshed);
    exportDistribution(root, policy, published);
    fs.writeFileSync(path.join(published, 'app/new.ts'), 'export const added = true;\n');
    const publishedPolicy = loadDistributionPolicy(published);

    expect(() => exportDistribution(published, publishedPolicy, refreshed))
      .toThrow(/boundary audit failed/i);
    expect(fs.existsSync(refreshed)).toBe(false);

    writeReviewedPathManifest(published, publishedPolicy);
    exportDistribution(published, publishedPolicy, refreshed);

    expect(fs.readFileSync(path.join(refreshed, 'app/new.ts'), 'utf8'))
      .toBe('export const added = true;\n');
    expect(auditDistributionBoundary(refreshed).ok).toBe(true);
  });

  it('does not let a stale receipt bypass unsafe selected source', () => {
    const root = fixture();
    const policy = loadDistributionPolicy(root);
    writeReviewedPathManifest(root, policy);
    const published = path.join(
      os.tmpdir(),
      `md3-foss-unsafe-source-${process.pid}-${Date.now()}`,
    );
    const refused = `${published}-refused`;
    temporaryRoots.push(published, refused);
    exportDistribution(root, policy, published);
    const credential = ['sk-proj', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
    fs.writeFileSync(
      path.join(published, 'app/unsafe.ts'),
      `export const credential = '${credential}';\n`,
    );
    const lockPath = path.join(published, policy.pathManifest);
    const reviewedPaths = fs.readFileSync(lockPath, 'utf8').trim().split('\n');
    reviewedPaths.push('app/unsafe.ts');
    fs.writeFileSync(lockPath, `${reviewedPaths.sort().join('\n')}\n`);
    const publishedPolicy = loadDistributionPolicy(published);

    expect(() => exportDistribution(published, publishedPolicy, refused))
      .toThrow(/boundary audit failed/i);
    expect(fs.existsSync(refused)).toBe(false);
    expect(auditDistributionBoundary(published, publishedPolicy, {
      verifyExistingExportManifest: false,
    }).issues).toContainEqual(expect.objectContaining({
      code: 'credential-shaped-text',
      path: 'app/unsafe.ts',
    }));
  });

  it('fails closed when a candidate is added or a reviewed path disappears', () => {
    const root = fixture();
    const policy = loadDistributionPolicy(root);
    writeReviewedPathManifest(root, policy);

    fs.writeFileSync(path.join(root, 'app/new.ts'), 'export const newValue = 2;\n');
    let report = auditDistributionBoundary(root, policy);
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'unreviewed-candidate',
      path: 'app/new.ts',
    }));

    fs.rmSync(path.join(root, 'app/index.ts'));
    report = auditDistributionBoundary(root, policy);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'reviewed-path-missing',
      path: 'app/index.ts',
    }));
  });

  it('requires tests under included roots to be explicitly allowlisted', () => {
    const root = fixture();
    const unlistedTest = 'app/private-course.test.ts';
    fs.writeFileSync(
      path.join(root, unlistedTest),
      "it('contains private fixtures', () => undefined);\n",
    );
    const policy = loadDistributionPolicy(root);

    let report = writeReviewedPathManifest(root, policy);
    expect(report.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, policy.pathManifest), 'utf8'))
      .not.toContain(`${unlistedTest}\n`);

    policy.includeFiles.push(unlistedTest);
    report = writeReviewedPathManifest(root, policy);
    expect(report.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, policy.pathManifest), 'utf8'))
      .toContain(`${unlistedTest}\n`);
  });

  it('rejects forbidden reviewed paths, symlinks, binaries, and credentials', () => {
    const root = fixture();
    const policy = loadDistributionPolicy(root);
    writeReviewedPathManifest(root, policy);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'md3-foss-boundary-outside-'));
    temporaryRoots.push(outside);

    fs.appendFileSync(path.join(root, policy.pathManifest), 'content/legacy.mdx\n');
    fs.symlinkSync(path.join(root, 'LICENSE'), path.join(root, 'app/link.ts'));
    fs.writeFileSync(path.join(outside, 'through.ts'), 'export const escaped = true;\n');
    fs.symlinkSync(outside, path.join(root, 'linked'));
    policy.includeFiles.push('linked/through.ts');
    fs.writeFileSync(path.join(root, 'app/blob.bin'), Buffer.from([0, 1, 2]));
    const credential = ['sk-proj', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
    fs.writeFileSync(path.join(root, 'app/credential.ts'), `export const credential = '${credential}';\n`);
    fs.writeFileSync(
      path.join(root, 'app/self-exempting.ts'),
      `export const credential = '${credential}'; // secret-scan: allow\n`,
    );
    fs.writeFileSync(
      path.join(root, 'app/personal.ts'),
      `export const owner = '${['private.person', 'rights-scan.invalid'].join('@')}';\n`,
    );

    const report = auditDistributionBoundary(root, policy);
    const codes = new Set(report.issues.map((issue) => issue.code));
    expect(codes.has('forbidden-reviewed-path')).toBe(true);
    expect(codes.has('selected-symlink')).toBe(true);
    expect(codes.has('unsupported-file-type')).toBe(true);
    expect(codes.has('credential-shaped-text')).toBe(true);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'credential-shaped-text',
      path: 'app/self-exempting.ts',
    }));
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'credential-shaped-text',
      path: 'app/personal.ts',
    }));
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'selected-symlink',
      path: 'linked/through.ts',
    }));
  });

  it('rejects learner identifiers from copied and generated text except the exact author credit', () => {
    const root = fixture();
    const authorPath = path.join(root, 'app/author.ts');
    const exactAuthor = ['I', 'an Todd / md3'].join('');
    fs.writeFileSync(
      authorPath,
      `export const itemText = { attribution: '${exactAuthor}' };\n`,
    );
    const policy = loadDistributionPolicy(root);
    writeReviewedPathManifest(root, policy);
    expect(auditDistributionBoundary(root, policy).ok).toBe(true);

    const learnerFixtures = new Map([
      ['app/learner-1.ts', ['I', 'an'].join('')],
      ['app/learner-2.ts', ['S', 'ia'].join('')],
      ['app/learner-3.ts', ['xiao', 'jing', 'xu'].join('')],
      ['app/learner-4.ts', ['todd', '.', 'i', 'an'].join('')],
    ]);
    for (const [relativePath, identifier] of learnerFixtures) {
      fs.writeFileSync(
        path.join(root, relativePath),
        `export const learner = '${identifier}';\n`,
      );
    }
    fs.writeFileSync(
      authorPath,
      `export const itemText = { attribution: '${exactAuthor} contributors' };\n`,
    );
    policy.generatedTextFiles.push({
      path: 'app/generated-learner.ts',
      text: `export const learner = '${['S', 'ia'].join('')}';\n`,
      licence: 'MIT',
    });

    const issues = auditDistributionBoundary(root, policy).issues;
    for (const relativePath of learnerFixtures.keys()) {
      expect(issues).toContainEqual(expect.objectContaining({
        code: 'learner-identifier',
        path: relativePath,
      }));
    }
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'learner-identifier',
      path: 'app/author.ts',
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'learner-identifier',
      path: 'app/generated-learner.ts',
    }));
  });

  it('rejects a generated fallback that collides with a copied file', () => {
    const root = fixture();
    const policy = loadDistributionPolicy(root);
    writeReviewedPathManifest(root, policy);
    policy.generatedTextFiles.push({
      path: 'app/index.ts',
      text: 'export const replacement = true;\n',
      licence: 'MIT',
    });

    const report = auditDistributionBoundary(root, policy);
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'generated-path-collision',
      path: 'app/index.ts',
    }));
  });

  it('rejects case-folded and ancestor generated-path collisions', () => {
    const root = fixture();
    const policy = loadDistributionPolicy(root);
    writeReviewedPathManifest(root, policy);
    policy.generatedTextFiles.push(
      {
        path: 'app/Generated-Fallback.json',
        text: '{}\n',
        licence: 'MIT',
      },
      {
        path: 'app/tree',
        text: 'parent\n',
        licence: 'MIT',
      },
      {
        path: 'app/tree/child.json',
        text: '{}\n',
        licence: 'MIT',
      },
    );

    const issues = auditDistributionBoundary(root, policy).issues;
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'generated-path-collision',
      path: 'app/Generated-Fallback.json',
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'generated-path-collision',
      path: 'app/tree',
    }));
  });

  it('pins dataset-free generated adapters for embedded teaching-data paths', () => {
    const root = process.cwd();
    const policy = loadDistributionPolicy(root);
    const fallback = policy.generatedTextFiles.find(
      (entry) => entry.path === 'src/lib/content-index.ts',
    );
    expect(fallback).toBeDefined();
    fallback!.text += '// unexpected course-derived teaching data\n';

    expect(auditDistributionBoundary(root, policy, {
      verifyExistingExportManifest: false,
    }).issues).toContainEqual(expect.objectContaining({
      code: 'non-foss-source-text',
      path: 'src/lib/content-index.ts',
    }));

    const copiedRotationIndex = policy.excludeFiles.indexOf('src/lib/rotation-metadata.json');
    expect(copiedRotationIndex).toBeGreaterThanOrEqual(0);
    policy.excludeFiles.splice(copiedRotationIndex, 1);
    expect(auditDistributionBoundary(root, policy, {
      verifyExistingExportManifest: false,
    }).issues).toContainEqual(expect.objectContaining({
      code: 'non-foss-source-text',
      path: 'src/lib/rotation-metadata.json',
    }));
  });

  it('requires every exported source to use an accepted FOSS licence record', () => {
    const root = fixture();
    const policy = loadDistributionPolicy(root);
    writeReviewedPathManifest(root, policy);
    const sourcesPath = path.join(root, 'open-content/usmle/step1/sources.json');

    fs.writeFileSync(sourcesPath, `${JSON.stringify({
      sources: [{
        attribution: 'Unknown-rights fixture',
        licence: {
          cls: 'unknown',
          id: 'unknown',
          url: 'https://example.test/rights',
        },
      }],
    })}\n`);
    expect(auditDistributionBoundary(root, policy).issues).toContainEqual(
      expect.objectContaining({
        code: 'non-foss-source-text',
        path: 'open-content/usmle/step1/sources.json',
      }),
    );

    fs.writeFileSync(sourcesPath, `${JSON.stringify({
      sources: [{
        attribution: 'Invented licence fixture',
        licence: {
          cls: 'foss',
          id: 'invented-open-terms',
          url: 'https://example.test/rights',
        },
      }],
    })}\n`);
    expect(auditDistributionBoundary(root, policy).issues).toContainEqual(
      expect.objectContaining({
        code: 'invalid-per-source-rights',
        path: 'open-content/usmle/step1/sources.json',
      }),
    );
  });

  it('requires an exact reviewed licence override for each selected authored document', () => {
    const root = fixture();
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'docs/unreviewed.md'),
      '# Unreviewed document\n',
    );
    const policy = loadDistributionPolicy(root);
    policy.includeFiles.push('docs/unreviewed.md');

    expect(() => writeReviewedPathManifest(root, policy)).toThrow(
      /non-foss-source-text:docs\/unreviewed\.md/,
    );

    policy.licenceOverrides.push({
      path: 'docs/unreviewed.md',
      licence: 'CC-BY-4.0',
    });
    const report = writeReviewedPathManifest(root, policy);

    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.licenseCounts['CC-BY-4.0']).toBe(2);
  });

  it('requires every exported question to resolve to the exact registered passage and licence', () => {
    const root = fixture();
    const questionPath = path.join(
      root,
      'open-content/usmle/step1/questions/domain/item.json',
    );
    fs.mkdirSync(path.dirname(questionPath), { recursive: true });
    const question = {
      cite: 'government-source#government-passage',
      publicUsmle: {
        itemText: { licence: 'CC-BY-4.0', attribution: 'Fixture contributors' },
        evidence: {
          kind: 'passage',
          sourceId: 'government-source',
          passageId: 'government-passage',
          licence: { cls: 'foss', id: 'us-gov' },
        },
      },
    };
    fs.writeFileSync(questionPath, `${JSON.stringify(question)}\n`);
    const policy = loadDistributionPolicy(root);
    writeReviewedPathManifest(root, policy);
    expect(auditDistributionBoundary(root, policy).ok).toBe(true);

    question.publicUsmle.evidence.passageId = 'unregistered-passage';
    fs.writeFileSync(questionPath, `${JSON.stringify(question)}\n`);
    expect(auditDistributionBoundary(root, policy).issues).toContainEqual(
      expect.objectContaining({
        code: 'invalid-open-content-rights',
        path: 'open-content/usmle/step1/questions/domain/item.json',
      }),
    );
  });

  it('rejects invalid UTF-8 even when a file has an allowed text extension', () => {
    const root = fixture();
    const policy = loadDistributionPolicy(root);
    writeReviewedPathManifest(root, policy);
    fs.writeFileSync(path.join(root, 'app/invalid.ts'), Buffer.from([0xc3, 0x28]));

    expect(auditDistributionBoundary(root, policy).issues).toContainEqual(
      expect.objectContaining({
        code: 'unsupported-file-type',
        path: 'app/invalid.ts',
      }),
    );
  });

  it('rejects contradictory and control-character policy paths', () => {
    const root = fixture();
    const policyPath = path.join(root, 'foss/distribution-policy.json');
    const policyInput = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
      excludeFiles: string[];
      includeFiles: string[];
    };
    policyInput.excludeFiles.push('LICENSE');
    fs.writeFileSync(policyPath, `${JSON.stringify(policyInput, null, 2)}\n`);
    expect(() => loadDistributionPolicy(root)).toThrow(/included file is also excluded/i);

    policyInput.excludeFiles.pop();
    policyInput.includeFiles.push('app/control\npath.ts');
    fs.writeFileSync(policyPath, `${JSON.stringify(policyInput, null, 2)}\n`);
    expect(() => loadDistributionPolicy(root)).toThrow(/POSIX repo-relative path/i);
  });

  it('refuses to replace a symlinked reviewed-path lock', () => {
    const root = fixture();
    const policy = loadDistributionPolicy(root);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'md3-foss-lock-outside-'));
    temporaryRoots.push(outside);
    const outsideLock = path.join(outside, 'paths.txt');
    fs.writeFileSync(outsideLock, 'sentinel\n');
    fs.rmSync(path.join(root, policy.pathManifest));
    fs.symlinkSync(outsideLock, path.join(root, policy.pathManifest));

    expect(() => writeReviewedPathManifest(root, policy)).toThrow(/selected-symlink/i);
    expect(fs.readFileSync(outsideLock, 'utf8')).toBe('sentinel\n');
  });

  it('exports only reviewed files and refuses to overwrite a destination', () => {
    const root = fixture();
    const policy = loadDistributionPolicy(root);
    writeReviewedPathManifest(root, policy);
    const output = path.join(os.tmpdir(), `md3-foss-export-test-${process.pid}-${Date.now()}`);
    const secondOutput = `${output}-second`;
    temporaryRoots.push(output);
    temporaryRoots.push(secondOutput);

    const first = exportDistribution(root, policy, output);
    const manifestText = fs.readFileSync(
      path.join(output, 'FOSS-DISTRIBUTION-MANIFEST.json'),
      'utf8',
    );
    const manifest = JSON.parse(manifestText) as {
      fileCount: number;
      files: Array<{ path: string; licence: string }>;
    };

    expect(first.fileCount).toBe(7);
    expect(manifest.fileCount).toBe(7);
    expect(manifest.files.map((file) => file.path)).not.toContain('content/legacy.mdx');
    expect(manifest.files).toContainEqual(expect.objectContaining({
      path: 'open-content/usmle/step1/item.json',
      licence: 'CC-BY-4.0',
    }));
    expect(manifest.files).toContainEqual(expect.objectContaining({
      path: 'open-content/usmle/step1/sources.json',
      licence: 'MIXED-PER-SOURCE',
    }));
    expect(fs.readFileSync(path.join(output, 'app/generated-fallback.json'), 'utf8')).toBe('{}\n');
    exportDistribution(root, policy, secondOutput);
    expect(fs.readFileSync(
      path.join(secondOutput, 'FOSS-DISTRIBUTION-MANIFEST.json'),
      'utf8',
    )).toBe(manifestText);
    expect(auditDistributionBoundary(output).ok).toBe(true);
    fs.mkdirSync(path.join(secondOutput, 'extra'));
    fs.writeFileSync(path.join(secondOutput, 'extra/private.txt'), 'not in manifest\n');
    expect(auditDistributionBoundary(secondOutput).issues).toContainEqual(expect.objectContaining({
      code: 'export-manifest-mismatch',
      path: 'extra/private.txt',
    }));
    fs.writeFileSync(path.join(output, 'app/generated-fallback.json'), '{"changed":true}\n');
    expect(auditDistributionBoundary(output).issues).toContainEqual(expect.objectContaining({
      code: 'export-manifest-mismatch',
      path: 'app/generated-fallback.json',
    }));
    const symlinkHolder = fs.mkdtempSync(path.join(os.tmpdir(), 'md3-foss-output-parent-'));
    temporaryRoots.push(symlinkHolder);
    const symlinkParent = path.join(symlinkHolder, 'repo-link');
    fs.symlinkSync(root, symlinkParent);
    expect(() => exportDistribution(
      root,
      policy,
      path.join(symlinkParent, 'escaped-export'),
    )).toThrow(/outside the source repository/i);
    expect(() => exportDistribution(root, policy, output)).toThrow(/already exists/i);
  });

  it('rejects a post-audit path-manifest mutation instead of exporting a non-candidate', () => {
    const root = fixture();
    const policy = loadDistributionPolicy(root);
    writeReviewedPathManifest(root, policy);
    fs.mkdirSync(path.join(root, 'private'));
    fs.writeFileSync(path.join(root, 'private/not-a-candidate.txt'), 'must not ship\n');
    const output = path.join(os.tmpdir(), `md3-foss-export-race-${process.pid}-${Date.now()}`);
    temporaryRoots.push(output);

    expect(() => exportDistribution(root, policy, output, {
      afterInitialAudit: () => {
        fs.appendFileSync(
          path.join(root, policy.pathManifest),
          'private/not-a-candidate.txt\n',
        );
      },
    })).toThrow(/inconsistent export snapshot|reviewed path manifest changed/i);
    expect(fs.existsSync(output)).toBe(false);
  });

  it('keeps the checked-in repository boundary green and structurally excludes unsafe roots', () => {
    const root = process.cwd();
    const policy = loadDistributionPolicy(root);
    const report = auditDistributionBoundary(root, policy, {
      // npm ci/build products intentionally make an installed validation copy
      // differ from its pristine artifact manifest. CLI self-audit remains strict.
      verifyExistingExportManifest: false,
    });

    expect(report.ok, JSON.stringify(report.issues, null, 2)).toBe(true);
    expect(policy.includeRoots).not.toContain('open-content/usmle/step1');
    expect(policy.includeFiles).toEqual(expect.arrayContaining([
      'open-content/usmle/step1/baseline-v1.json',
      'open-content/usmle/step1/release-v1.json',
      'open-content/usmle/step1/sources.json',
    ]));
    expect(policy.forbiddenPrefixes).toEqual(expect.arrayContaining([
      'audit',
      'content',
      'data',
      'public/figures',
      'question-bank',
    ]));
    expect(policy.excludePrefixes).toEqual(expect.arrayContaining([
      'src/app/(usyd-md1)',
      'src/app/(usyd-md2)',
      'src/app/__qa-wba4',
      'src/app/admin',
      'src/app/api/admin',
      'src/app/api/analytics',
      'src/app/api/audit',
      'src/app/api/cards',
      'src/app/api/citations',
      'src/app/api/concepts',
      'src/app/api/content-audit',
      'src/app/api/content-lake',
      'src/app/api/content-quality',
      'src/app/api/cron',
      'src/app/api/deck',
      'src/app/api/deep-dive',
      'src/app/api/ecg',
      'src/app/api/exams',
      'src/app/api/figures',
      'src/app/api/glossary',
      'src/app/api/integrations',
      'src/app/api/knowledge',
      'src/app/api/learn',
      'src/app/api/manifold',
      'src/app/api/map',
      'src/app/api/mastery',
      'src/app/api/mobile',
      'src/app/api/modules',
      'src/app/api/question-bank',
      'src/app/api/questions',
      'src/app/api/quiz',
      'src/app/api/sandbox',
      'src/app/api/smp',
      'src/app/api/study',
      'src/app/api/sync',
      'src/app/api/terminology',
      'src/app/api/user/context',
      'src/app/api/user/documents',
      'src/app/api/videos',
      'src/app/auth/verify-email',
      'src/app/cards',
      'src/app/content',
      'src/app/deep-dive',
      'src/app/docs',
      'src/app/download/harvester',
      'src/app/f',
      'src/app/learn',
      'src/app/practice',
      'src/app/profile/documents',
      'src/app/questions',
      'src/app/qa-wba4',
      'src/app/qa-wba4-checklist',
      'src/app/review',
      'src/app/sandbox',
      'src/app/study',
      'src/app/x',
      'src/data',
      'src/lib/generated',
      'src/lib/integrations',
      'src/app/wba',
    ]));
    expect(policy.excludeFiles).toEqual(expect.arrayContaining([
      'src/components/content/AlgorithmSteps.tsx',
      'src/components/content/Citation.tsx',
      'src/components/content/QuestionBankMCQ.tsx',
      'src/components/content/glossary-autowrap.test.ts',
      'src/components/ecg/ECGViewer.tsx',
      'src/components/review/ABGContextPanel.test.ts',
      'src/components/TermProvider.tsx',
      'src/components/Navigation.tsx',
      'src/components/offline/OfflineTabShell.tsx',
      'src/hooks/useActiveModules.ts',
      'src/lib/anking-scaffold-content.test.ts',
      'src/lib/card-generator.test.ts',
      'src/lib/card-validators.test.ts',
      'src/lib/content-gen/liked-variants.test.ts',
      'src/lib/content-quality/mdx-authoring.test.ts',
      'src/lib/content-index.ts',
      'src/lib/current-study.ts',
      'src/lib/curriculum/index.ts',
      'src/lib/curriculum/usyd-md1-2026.ts',
      'src/lib/curriculum/usyd-md2-2026.ts',
      'src/lib/inline-markdown.test.tsx',
      'src/lib/institution-rotations.ts',
      'src/lib/legacy-api-quarantine.ts',
      'src/lib/manifold/question-complexity.ts',
      'src/lib/manifold/exam-calibration.test.ts',
      'src/lib/question-groups/abg-cases.ts',
      'src/lib/card-bank/stuanki-loader.ts',
      'src/lib/personal-decks.ts',
      'src/lib/personal-brief-harvest.ts',
      'src/lib/personal-brief-offline.test.ts',
      'src/lib/personal-brief.test.ts',
      'src/lib/r2.ts',
      'src/lib/user-document-lifecycle.ts',
      'src/app/profile/profile-documents.tsx',
      'src/app/page.tsx',
      'src/app/review-authenticated-bootstrap.tsx',
      'src/app/review-page-client.tsx',
      'src/app/review-session-boundary.tsx',
      'src/app/profile/settings/PersonalDocumentsDestination.tsx',
      'src/lib/question-bank/contrast-set.test.ts',
      'src/lib/question-bank/validate.test.ts',
      'src/lib/questions/private-access-session.ts',
      'src/lib/questions/private-access.ts',
      'src/lib/retired-medkit-api.ts',
      'src/lib/review/scheduler-config.ts',
      'src/lib/rotation-context.ts',
      'src/lib/rotation-labels.ts',
      'src/lib/rotation-metadata.json',
      'src/lib/rotation-schedule.ts',
      'src/lib/rotations.ts',
      'src/lib/usmle/anki-parser.ts',
      'src/lib/source-registry-data.json',
      'src/lib/utils/split-sentences.test.ts',
      'vitest.setup.ts',
    ]));
    const reviewedPaths = fs.readFileSync(
      path.join(root, policy.pathManifest),
      'utf8',
    ).trim().split('\n');
    expect(reviewedPaths).not.toEqual(expect.arrayContaining([
      'src/app/(usyd-md1)/layout.tsx',
      'src/app/(usyd-md1)/md1/layout.tsx',
      'src/app/(usyd-md1)/md1/page.tsx',
      'src/app/(usyd-md1)/md1/study/page.tsx',
      'src/app/(usyd-md2)/layout.tsx',
      'src/app/(usyd-md2)/md2/layout.tsx',
      'src/app/(usyd-md2)/md2/page.tsx',
      'src/app/(usyd-md2)/md2/study/page.tsx',
      'src/components/review/ABGContextPanel.test.ts',
      'src/lib/anking-scaffold-content.test.ts',
      'src/lib/manifold/exam-calibration.test.ts',
      'src/lib/personal-brief-offline.test.ts',
      'src/lib/personal-brief.test.ts',
    ]));
    expect(policy.includeRoots).toEqual(expect.arrayContaining([
      'prisma/migrations',
      'prisma/schema',
    ]));
    expect(policy.includeRoots).not.toContain('prisma');
    expect(policy.includeRoots).not.toContain('tests/integration');
    expect(policy.includeFiles).toEqual(expect.arrayContaining([
      'scripts/content-lake/storage.ts',
      'scripts/content-lake/types.ts',
      'scripts/db/destructive-guard.mjs',
      'scripts/db/destructive-guard.test.ts',
      'scripts/lib/db.ts',
    ]));
    expect(policy.includeFiles).not.toContain('docs/curriculum/usmle-step1.md');
    expect(policy.includeFiles).toContain('src/app/about/page.test.tsx');
    expect(policy.includeFiles).not.toContain('next.config.ts');
    expect(policy.includeFiles).not.toContain('next.config.test.ts');
    const selectedAuthoredDocuments = policy.includeFiles.filter(
      (filePath) => filePath.startsWith('docs/')
        || filePath === 'CONTRIBUTING.md'
        || filePath === 'LICENSE-CONTENT.md',
    );
    for (const filePath of selectedAuthoredDocuments) {
      expect(policy.licenceOverrides).toContainEqual({
        path: filePath,
        licence: 'CC-BY-4.0',
      });
    }
    expect(policy.includeFiles).not.toEqual(expect.arrayContaining([
      'package.json',
      'README.md',
    ]));
    expect(policy.generatedTextFiles).toContainEqual(expect.objectContaining({
      path: 'prisma.config.ts',
    }));
    expect(policy.generatedTextFiles).toContainEqual(expect.objectContaining({
      path: 'src/lib/personal-decks.ts',
    }));
    expect(policy.generatedTextFiles).toContainEqual(expect.objectContaining({
      path: 'src/lib/content-index.ts',
      licence: 'CC-BY-4.0',
    }));
    expect(policy.generatedTextFiles).toContainEqual(expect.objectContaining({
      path: 'src/lib/rotation-metadata.json',
      text: '{}\n',
    }));
    for (const generatedPath of [
      'src/lib/current-study.ts',
      'src/lib/institution.ts',
      'src/lib/institution-rotations.ts',
      'src/lib/offline/fill.ts',
      'src/lib/offline/figures.ts',
      'src/app/profile/settings/PersonalDocumentsDestination.tsx',
      'src/lib/rotation-labels.ts',
      'src/lib/rotations.ts',
      'src/app/brief/page.tsx',
      'src/app/privacy/page.tsx',
      'src/app/terms/page.tsx',
      'src/lib/questions/private-access-session.ts',
      'src/lib/questions/private-access.ts',
      'src/lib/review/scheduler-config.ts',
      'vitest.setup.ts',
    ]) {
      expect(policy.generatedTextFiles).toContainEqual(expect.objectContaining({
        path: generatedPath,
        licence: 'MIT',
      }));
    }
    expect(policy.generatedTextFiles).toContainEqual(expect.objectContaining({
      path: 'src/components/content/AlgorithmSteps.tsx',
    }));
    expect(policy.generatedTextFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.github/workflows/ci.yml' }),
      expect.objectContaining({ path: 'next.config.ts' }),
      expect.objectContaining({ path: 'package.json' }),
      expect.objectContaining({ path: 'README.md' }),
      expect.objectContaining({ path: 'src/app/privacy/page.tsx' }),
      expect.objectContaining({ path: 'src/app/page.tsx' }),
      expect.objectContaining({ path: 'src/app/content/page.tsx' }),
      expect.objectContaining({ path: 'src/app/terms/page.tsx' }),
      expect.objectContaining({ path: 'src/components/Navigation.tsx' }),
      expect.objectContaining({ path: 'src/components/TermProvider.tsx' }),
      expect.objectContaining({ path: 'src/components/content/Citation.tsx' }),
      expect.objectContaining({ path: 'src/components/content/QuestionBankMCQ.tsx' }),
      expect.objectContaining({ path: 'src/components/offline/OfflineTabShell.tsx' }),
      expect.objectContaining({ path: 'src/lib/curriculum/index.ts' }),
      expect.objectContaining({ path: 'src/lib/manifold/question-complexity.ts' }),
      expect.objectContaining({ path: 'src/lib/rotation-context.ts' }),
      expect.objectContaining({ path: 'src/hooks/useActiveModules.ts' }),
      expect.objectContaining({ path: 'vercel.json' }),
    ]));
    const isExcludedSourcePath = (filePath: string) => (
      policy.excludeFiles.includes(filePath)
      || policy.excludePrefixes.some((prefix) => (
        filePath === prefix || filePath.startsWith(`${prefix}/`)
      ))
    );
    const generatedReplacementPaths = policy.generatedTextFiles
      .filter((file) => isExcludedSourcePath(file.path))
      .map((file) => file.path)
      .sort();
    const pinnedReplacementPaths = PROTECTED_PUBLIC_FALLBACKS
      .filter((file) => isExcludedSourcePath(file.path))
      .map((file) => file.path)
      .sort();
    expect(new Set(PROTECTED_PUBLIC_FALLBACKS.map((file) => file.path)).size)
      .toBe(PROTECTED_PUBLIC_FALLBACKS.length);
    expect(pinnedReplacementPaths).toEqual(generatedReplacementPaths);
    const unpinnedPolicy = structuredClone(policy);
    unpinnedPolicy.generatedTextFiles.push({
      path: 'src/lib/personal-brief-harvest.ts',
      text: 'export {};\n',
      licence: 'MIT',
    });
    expect(auditDistributionBoundary(root, unpinnedPolicy, {
      verifyExistingExportManifest: false,
    }).issues).toContainEqual(expect.objectContaining({
      code: 'non-foss-source-text',
      path: 'src/lib/personal-brief-harvest.ts',
    }));
    const publicPackageDefinition = policy.generatedTextFiles.find(
      (entry) => entry.path === 'package.json',
    );
    const publicReadme = policy.generatedTextFiles.find(
      (entry) => entry.path === 'README.md',
    )!.text;
    expect(publicReadme).toContain('leave AUTH_URL and NEXTAUTH_URL unset');
    expect(publicReadme).toContain('AUTH_TRUST_MD3_COHORT_HOSTS=true');
    expect(publicReadme).toContain(
      '/usmle is a public early product: guests and signed-in users can study',
    );
    expect(publicReadme).toContain('https://md3.info/api/auth/callback/google');
    expect(publicReadme).toContain('https://cohort.md/api/auth/callback/google');
    expect(publicReadme).toContain('not affiliated with or endorsed by the USMLE program');
    expect(publicReadme).toContain('https://www.usmle.org/about-usmle');
    expect(publicReadme).toContain(
      'https://www.usmle.org/what-to-know/exam-security-fairness',
    );
    expect(publicReadme).not.toMatch(
      /docs\/(?:ARCHITECTURE|REVIEW_SYSTEM|AGENT_DATA_GUIDE|CARD_QUALITY|CONTENT_PIPELINE)\.md|CLAUDE\.md/,
    );
    const publicPackage = JSON.parse(publicPackageDefinition!.text) as {
      scripts: Record<string, string>;
    };
    expect(Object.keys(publicPackage.scripts)).toHaveLength(34);
    const publicTestPaths = [...publicPackage.scripts['foss:test'].matchAll(
      /(?:^|\s)["']?([^\s"']+\.test\.tsx?)["']?/g,
    )].map((match) => match[1]);
    expect(publicTestPaths).toHaveLength(48);
    expect(policy.includeFiles).toEqual(expect.arrayContaining(publicTestPaths));
    expect(JSON.stringify(publicPackage.scripts)).not.toMatch(
      /(?:^|\s)question-bank\/|anki-import|scripts\/personal|audit:tooling-contract|seed-private/i,
    );
    expect(publicPackage.scripts.test).toBe('npm run foss:test');
    expect(publicPackage.scripts['foss:boundary:audit']).toContain('--source-tree');
    const offlineGenerationPrerequisites = publicPackage.scripts['typecheck:scripts'].replace(
      / && tsc --noEmit -p tsconfig\.scripts\.json$/,
      '',
    );
    expect(publicPackage.scripts['prefoss:test']).toBe(offlineGenerationPrerequisites);
    expect(publicPackage.scripts['prefoss:test']).toContain(
      'scripts/content/generate-content-map.ts',
    );
    expect(publicPackage.scripts['prefoss:test']).toContain(
      'scripts/content/generate-starter-sessions.ts',
    );
    expect(publicPackage.scripts['typecheck:scripts']).toContain('prisma generate');
    expect(publicPackage.scripts['foss:test']).toContain(
      'reinforcement-card-egress-contract.test.ts',
    );
    expect(publicPackage.scripts['foss:test']).toContain(
      'scripts/foss/public-navigation.test.ts',
    );
    expect(publicPackage.scripts['foss:test']).toContain(
      'scripts/ops/public-answer-artifacts.test.ts',
    );
    expect(publicPackage.scripts['foss:test']).toContain(
      'src/lib/auth-verification-email.test.ts',
    );
    expect(publicPackage.scripts['usmle:reinforcement:test']).toContain(
      'reinforcement-card-egress-contract.test.ts',
    );
    expect(publicPackage.scripts['usmle:release:fingerprints:write']).toContain(
      '--write-release-fingerprints',
    );
    const publicWorkflow = policy.generatedTextFiles.find(
      (entry) => entry.path === '.github/workflows/ci.yml',
    )!.text;
    expect(() => parseYaml(publicWorkflow)).not.toThrow();
    expect(publicWorkflow).toContain('npm run foss:export');
    expect(publicWorkflow).toContain('Strictly audit fresh artifact');
    expect(publicWorkflow).not.toContain('Capture pristine tracked artifact');
    expect(publicWorkflow).toContain('npm run typecheck:scripts');
    expect(publicWorkflow).toContain('npm run lint');
    expect(publicWorkflow.match(/working-directory: \$\{\{ runner\.temp \}\}\/md3-foss-current/g))
      .toHaveLength(9);
    const publicRotationContext = policy.generatedTextFiles.find(
      (entry) => entry.path === 'src/lib/rotation-context.ts',
    )!.text;
    const publicContentIndex = policy.generatedTextFiles.find(
      (entry) => entry.path === 'src/lib/content-index.ts',
    )!.text;
    const publicInstitution = policy.generatedTextFiles.find(
      (entry) => entry.path === 'src/lib/institution.ts',
    )!.text;
    const publicBrief = policy.generatedTextFiles.find(
      (entry) => entry.path === 'src/app/brief/page.tsx',
    )!.text;
    const publicDocumentsDestination = policy.generatedTextFiles.find(
      (entry) => entry.path === 'src/app/profile/settings/PersonalDocumentsDestination.tsx',
    )!.text;
    const publicTermProvider = policy.generatedTextFiles.find(
      (entry) => entry.path === 'src/components/TermProvider.tsx',
    )!.text;
    const publicQuestionBankMcq = policy.generatedTextFiles.find(
      (entry) => entry.path === 'src/components/content/QuestionBankMCQ.tsx',
    )!.text;
    const publicCitation = policy.generatedTextFiles.find(
      (entry) => entry.path === 'src/components/content/Citation.tsx',
    )!.text;
    const publicHome = policy.generatedTextFiles.find(
      (entry) => entry.path === 'src/app/page.tsx',
    )!.text;
    const publicContent = policy.generatedTextFiles.find(
      (entry) => entry.path === 'src/app/content/page.tsx',
    )!.text;
    const publicNavigation = policy.generatedTextFiles.find(
      (entry) => entry.path === 'src/components/Navigation.tsx',
    )!.text;
    const publicActiveModules = policy.generatedTextFiles.find(
      (entry) => entry.path === 'src/hooks/useActiveModules.ts',
    )!.text;
    const publicOfflineFill = policy.generatedTextFiles.find(
      (entry) => entry.path === 'src/lib/offline/fill.ts',
    )!.text;
    const publicOfflineShell = policy.generatedTextFiles.find(
      (entry) => entry.path === 'src/components/offline/OfflineTabShell.tsx',
    )!.text;
    const publicOfflineFigures = policy.generatedTextFiles.find(
      (entry) => entry.path === 'src/lib/offline/figures.ts',
    )!.text;
    const publicNextConfig = policy.generatedTextFiles.find(
      (entry) => entry.path === 'next.config.ts',
    )!.text;
    const publicPrivacy = policy.generatedTextFiles.find(
      (entry) => entry.path === 'src/app/privacy/page.tsx',
    )!.text;
    const publicTerms = policy.generatedTextFiles.find(
      (entry) => entry.path === 'src/app/terms/page.tsx',
    )!.text;
    const publicVercel = JSON.parse(policy.generatedTextFiles.find(
      (entry) => entry.path === 'vercel.json',
    )!.text) as Record<string, unknown>;
    expect(publicRotationContext).toContain('export type RotationId = string;');
    expect(publicRotationContext).toContain("return 'open-learning';");
    expect(publicContentIndex).toContain("id: 'open-learning' as const");
    expect(publicInstitution).toContain('export const SUPPORTS_PERSONAL_BRIEF = false;');
    expect(publicInstitution).toContain('export const SUPPORTS_PERSONAL_DOCUMENTS = false;');
    expect(publicInstitution).toContain('export const SUPPORTS_CLINICAL_EXAMS = false;');
    expect(publicBrief).toContain("redirect('/profile')");
    expect(publicDocumentsDestination).toContain('return null;');
    expect(publicDocumentsDestination).not.toContain('/profile/documents');
    expect(publicTermProvider).not.toMatch(/\bfetch\s*\(|\/api\/glossary/);
    expect(publicQuestionBankMcq).not.toMatch(/\bfetch\s*\(|\/api\/question-bank/);
    expect(publicCitation).not.toMatch(/\bfetch\s*\(|\/api\/citations/);
    expect(publicHome).toContain("redirect('/usmle')");
    expect(publicContent).toContain("redirect('/usmle/step1')");
    expect(publicNavigation).toContain("href: '/usmle/step1'");
    expect(publicNavigation).toContain("href: '/about'");
    expect(publicNavigation).not.toMatch(/\/content|\/exams|\/review/);
    expect(publicActiveModules).not.toMatch(/\bfetch\s*\(|\/api\/modules/);
    expect(publicOfflineFill).not.toMatch(/\/api\/study\/offline-pack|\bfetch\s*\(/);
    expect(publicOfflineShell).toContain('does not download answer-bearing study sessions');
    expect(publicOfflineShell).toContain('href="/usmle/step1"');
    expect(publicOfflineShell).not.toMatch(
      /ClinicalLesson|ExamProtocol|UnifiedReview|BriefView|\/api\//,
    );
    expect(publicOfflineFigures).not.toMatch(/\bfetch\s*\(|\/api\/figures|\/figures\//);
    expect(publicOfflineFigures).toContain('return 0;');
    expect(publicNextConfig).toContain('configuredHttpsUrl');
    expect(publicNextConfig).toContain('vercelAnalyticsCspSources');
    expect(publicNextConfig).toContain('${analyticsScriptSourceList}');
    expect(publicNextConfig).toContain('${analyticsConnectSourceList}');
    expect(publicNextConfig).not.toMatch(
      /https:\/\/(?:va\.vercel-scripts\.com|vitals\.vercel-insights\.com)/,
    );
    expect(publicNextConfig).not.toContain('/static-queues');
    expect(publicNextConfig).not.toMatch(
      /source:\s*['"]\/figures|destination:\s*`?\$\{base\}\/figures|Cache-Control[^]*\/figures/,
    );
    expect(publicNextConfig).not.toMatch(
      /07a71a4e03927825c004e38b1c2ed9d1|pub-65e46a1a34f14c58abccbea86fffdac9|pub-c376f836c4cc4ecfae4c8b545e006a47|md3-anatomy|md3-videos-private|md3-user-documents-private|md3-figures|\/figures\/ecg-db/,
    );
    expect(publicPrivacy).toContain(
      'artifact itself provides no self-service account-data export or account deletion',
    );
    expect(publicPrivacy).toContain('Before onboarding learners');
    expect(publicPrivacy).not.toContain('reference application provides account export');
    expect(publicTerms).toContain('LICENSE-CONTENT.md');
    expect(publicTerms).toContain('must not contradict');
    expect(publicVercel).toEqual({
      framework: 'nextjs',
      buildCommand: 'npm run build:release',
    });
    const sensitiveFallbackText = policy.generatedTextFiles
      .filter((entry) => [
        'src/components/content/AlgorithmSteps.tsx',
        'src/app/brief/page.tsx',
        'src/lib/curriculum/index.ts',
        'src/lib/institution.ts',
        'src/lib/manifold/question-complexity.ts',
        'src/lib/offline/fill.ts',
        'src/lib/rotation-context.ts',
      ].includes(entry.path))
      .map((entry) => entry.text)
      .join('\n');
    expect(sensitiveFallbackText).not.toMatch(
      /Academic Planner|Australian med|summative exam|KAT7|2026-0[1-9]-|DRSABCD \(Basic|\/md[12]\b|\/profile\/brief|\/api\/study\/offline-pack/i,
    );
    const artifactPaths = new Set([
      ...fs.readFileSync(path.join(root, policy.pathManifest), 'utf8').split('\n').filter(Boolean),
      ...policy.generatedTextFiles.map((entry) => entry.path),
    ]);
    const selectedApiRoutes = [...artifactPaths]
      .filter((filePath) => /^src\/app\/api\/.+\/route\.(?:js|jsx|ts|tsx)$/.test(filePath))
      .sort();
    expect(selectedApiRoutes).toEqual([...PUBLIC_API_ROUTE_PATHS].sort());
    const selectedPages = [...artifactPaths]
      .filter((filePath) => /^src\/app(?:\/.*)?\/page\.(?:js|jsx|ts|tsx)$/.test(filePath))
      .sort();
    expect(selectedPages).toEqual([...PUBLIC_PAGE_ROUTE_PATHS].sort());
    const selectedAppHandlers = [...artifactPaths]
      .filter((filePath) => (
        !filePath.startsWith('src/app/api/')
        && /^src\/app\/.+\/route\.(?:js|jsx|ts|tsx)$/.test(filePath)
      ))
      .sort();
    expect(selectedAppHandlers).toEqual([...PUBLIC_APP_HANDLER_ROUTE_PATHS].sort());
    const selectedAppShellFiles = [...artifactPaths]
      .filter((filePath) => (
        /^src\/app(?:\/.*)?\/(?:default|error|global-error|layout|loading|not-found|template)\.(?:js|jsx|ts|tsx)$/
          .test(filePath)
      ))
      .sort();
    expect(selectedAppShellFiles).toEqual([...PUBLIC_APP_SHELL_PATHS].sort());
    const selectedMetadataRoutes = [...artifactPaths]
      .filter((filePath) => (
        /^src\/app(?:\/.*)?\/(?:apple-icon|icon|manifest|opengraph-image|robots|sitemap|twitter-image)\.(?:js|jsx|ts|tsx)$/
          .test(filePath)
      ))
      .sort();
    expect(selectedMetadataRoutes).toEqual([...PUBLIC_METADATA_ROUTE_PATHS].sort());
    expect([...artifactPaths].filter((filePath) => filePath.startsWith('public/static-queues/')))
      .toEqual([]);
    expect(policy.includeFiles).not.toContain('scripts/content/generate-static-queues.ts');
    expect(publicPackage.scripts).not.toHaveProperty('generate:static-queues');
    expect(JSON.stringify(publicPackage.scripts)).not.toContain('generate-static-queues');

    const widenedPolicy = structuredClone(policy);
    widenedPolicy.generatedTextFiles.push({
      path: 'src/app/api/unreviewed/route.ts',
      text: 'export {}\n',
      licence: 'MIT',
    });
    expect(auditDistributionBoundary(root, widenedPolicy, {
      verifyExistingExportManifest: false,
    }).issues).toContainEqual(expect.objectContaining({
      code: 'non-foss-source-text',
      path: 'src/app/api/unreviewed/route.ts',
    }));
    const widenedPagePolicy = structuredClone(policy);
    widenedPagePolicy.generatedTextFiles.push({
      path: 'src/app/unreviewed/page.js',
      text: 'export default function Page() { return null; }\n',
      licence: 'MIT',
    });
    expect(auditDistributionBoundary(root, widenedPagePolicy, {
      verifyExistingExportManifest: false,
    }).issues).toContainEqual(expect.objectContaining({
      code: 'non-foss-source-text',
      path: 'src/app/unreviewed/page.js',
    }));
    const widenedHandlerPolicy = structuredClone(policy);
    widenedHandlerPolicy.generatedTextFiles.push({
      path: 'src/app/unreviewed/route.js',
      text: 'export function GET() { return new Response(null); }\n',
      licence: 'MIT',
    });
    expect(auditDistributionBoundary(root, widenedHandlerPolicy, {
      verifyExistingExportManifest: false,
    }).issues).toContainEqual(expect.objectContaining({
      code: 'non-foss-source-text',
      path: 'src/app/unreviewed/route.js',
    }));
    const widenedShellPolicy = structuredClone(policy);
    widenedShellPolicy.generatedTextFiles.push({
      path: 'src/app/unreviewed/layout.jsx',
      text: 'export default function Layout({ children }) { return children; }\n',
      licence: 'MIT',
    });
    expect(auditDistributionBoundary(root, widenedShellPolicy, {
      verifyExistingExportManifest: false,
    }).issues).toContainEqual(expect.objectContaining({
      code: 'non-foss-source-text',
      path: 'src/app/unreviewed/layout.jsx',
    }));
    const widenedMetadataPolicy = structuredClone(policy);
    widenedMetadataPolicy.generatedTextFiles.push({
      path: 'src/app/sitemap.js',
      text: 'export default function sitemap() { return []; }\n',
      licence: 'MIT',
    });
    expect(auditDistributionBoundary(root, widenedMetadataPolicy, {
      verifyExistingExportManifest: false,
    }).issues).toContainEqual(expect.objectContaining({
      code: 'non-foss-source-text',
      path: 'src/app/sitemap.js',
    }));
    const publicIcons = policy.allowedBinaryFiles.filter((entry) => (
      entry.path.startsWith('public/icons/')
    ));
    expect(publicIcons).toHaveLength(8);
    for (const icon of publicIcons) {
      expect(icon).toEqual(expect.objectContaining({ licence: 'MIT', notice: 'LICENSE' }));
      expect(policy.includeFiles).toContain(icon.path);
    }
    expect(policy.licenceOverrides).toContainEqual({
      path: 'open-content/usmle/step1/sources.json',
      licence: 'MIXED-PER-SOURCE',
    });
  });
});
