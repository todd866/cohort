#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const POLICY_PATH = 'foss/distribution-policy.json';
const NORMALIZED_MTIME = new Date('2000-01-01T00:00:00.000Z');

export type DistributionLicence =
  | 'MIT'
  | 'CC-BY-4.0'
  | 'OFL-1.1'
  | 'MIXED-PER-SOURCE';

export interface AllowedBinaryFile {
  path: string;
  sha256: string;
  licence: DistributionLicence;
  notice: string;
}

export interface GeneratedTextFile {
  path: string;
  text: string;
  licence: DistributionLicence;
}

export interface LicenceOverride {
  path: string;
  licence: DistributionLicence;
}

export interface DistributionPolicy {
  schemaVersion: 1;
  pathManifest: string;
  includeRoots: string[];
  includeFiles: string[];
  excludePrefixes: string[];
  excludeFiles: string[];
  forbiddenPrefixes: string[];
  allowedTextExtensions: string[];
  allowedBinaryFiles: AllowedBinaryFile[];
  licenceOverrides: LicenceOverride[];
  generatedTextFiles: GeneratedTextFile[];
  maximumFileBytes: number;
}

export type DistributionIssueCode =
  | 'credential-shaped-text'
  | 'export-manifest-mismatch'
  | 'explicit-path-missing'
  | 'file-too-large'
  | 'forbidden-candidate-path'
  | 'forbidden-reviewed-path'
  | 'generated-path-collision'
  | 'invalid-path-manifest'
  | 'invalid-open-content-rights'
  | 'invalid-per-source-rights'
  | 'invalid-public-package'
  | 'invalid-public-workflow'
  | 'learner-identifier'
  | 'non-foss-source-text'
  | 'path-manifest-not-sorted'
  | 'portable-path-collision'
  | 'reviewed-path-missing'
  | 'selected-symlink'
  | 'third-party-binary-hash-mismatch'
  | 'third-party-notice-missing'
  | 'unreviewed-candidate'
  | 'unsupported-file-type';

export interface DistributionIssue {
  code: DistributionIssueCode;
  path: string;
  detail: string;
}

export interface DistributionAuditReport {
  schemaVersion: 1;
  ok: boolean;
  policyPath: string;
  pathManifest: string;
  fileCount: number;
  totalBytes: number;
  licenseCounts: Partial<Record<DistributionLicence, number>>;
  issues: DistributionIssue[];
}

interface CandidateDiscovery {
  paths: string[];
  issues: DistributionIssue[];
}

interface InspectedFile {
  bytes: number;
  buffer: Buffer;
  licence: DistributionLicence;
  mode: '0644' | '0755';
  sha256: string;
}

interface ExportFileRecord {
  path: string;
  bytes: number;
  sha256: string;
  mode: '0644' | '0755';
  licence: DistributionLicence;
}

interface ExportManifest {
  schemaVersion: 1;
  boundaryPolicy: string;
  boundaryPolicySha256: string;
  reviewedPathsSha256: string;
  fileCount: number;
  totalBytes: number;
  files: ExportFileRecord[];
}

interface SnapshottedExportFile extends ExportFileRecord {
  buffer: Buffer;
}

interface ExportSnapshot {
  files: SnapshottedExportFile[];
  policySha256: string;
  reviewedPathsSha256: string;
  totalBytes: number;
}

export interface DistributionAuditOptions {
  /** Source-tree audits/path-lock refreshes may omit an old artifact-integrity receipt. */
  verifyExistingExportManifest?: boolean;
}

export interface DistributionExportHooks {
  /** Test seam for proving that post-audit source mutations fail closed. */
  afterInitialAudit?: () => void;
}

const EXPORT_MANIFEST_PATH = 'FOSS-DISTRIBUTION-MANIFEST.json';

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'private-key-block', pattern: /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/ },
  { name: 'openai-or-anthropic-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: 'google-oauth-secret', pattern: /\bGOCSPX-[0-9A-Za-z_-]{20,}\b/ },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'resend-key', pattern: /\bre_[A-Za-z0-9]{20,}\b/ },
  { name: 'neon-password', pattern: /\bnpg_[A-Za-z0-9]{20,}\b/ },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  { name: 'personal-email-fixture', pattern: /\bprivate\.person@rights-scan\.invalid\b/i },
  {
    name: 'personal-consumer-email',
    pattern: /\b[A-Z0-9._%+-]+@(?:gmail\.com|outlook\.com|hotmail\.com|icloud\.com)\b/i,
  },
  {
    name: 'personal-university-email',
    pattern: /\b[A-Z0-9._%+-]+@uni\.sydney\.edu\.au\b/i,
  },
  { name: 'absolute-macos-home', pattern: /\/Users\/[A-Za-z0-9._-]+\// },
  { name: 'absolute-linux-home', pattern: /\/home\/[A-Za-z0-9._-]+\// },
];

function wholeWordPattern(fragments: string[]): RegExp {
  const value = fragments.join('').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${value}\\b`, 'i');
}

const LEARNER_IDENTIFIER_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'learner-handle-1', pattern: wholeWordPattern(['todd', '.', 'i', 'an']) },
  { name: 'learner-handle-2', pattern: wholeWordPattern(['xiao', 'jing', 'xu']) },
  { name: 'learner-name-1', pattern: wholeWordPattern(['I', 'an']) },
  { name: 'learner-name-2', pattern: wholeWordPattern(['S', 'ia']) },
];

const EXACT_PUBLIC_AUTHOR_ATTRIBUTION = ['I', 'an Todd / md3'].join('');

/**
 * Deliberately small request surface for the public Step 1 alpha. Keep this as
 * exact route-file paths so adding a route anywhere under src/app/api fails the
 * distribution audit until it is explicitly reviewed here and in the policy.
 */
export const PUBLIC_API_ROUTE_PATHS: ReadonlyArray<string> = Object.freeze([
  'src/app/api/auth/[...nextauth]/route.ts',
  'src/app/api/auth/claim-guest-progress/route.ts',
  'src/app/api/content/flag/route.ts',
  'src/app/api/help/route.ts',
  'src/app/api/log/client-error/route.ts',
  'src/app/api/offline/telemetry/route.ts',
  'src/app/api/security/csp-report/route.ts',
  'src/app/api/track/route.ts',
  'src/app/api/user/cc-subrotation/route.ts',
  'src/app/api/user/email-aliases/route.ts',
  'src/app/api/user/email-aliases/verify/route.ts',
  'src/app/api/user/minimal/route.ts',
  'src/app/api/user/rotation/route.ts',
  'src/app/api/user/route.ts',
  'src/app/api/usmle/step1/answer/route.ts',
  'src/app/api/usmle/step1/progress/route.ts',
  'src/app/api/usmle/step1/session/route.ts',
]);

/** Exact App Router page surface for the public Step 1 alpha. */
export const PUBLIC_PAGE_ROUTE_PATHS: ReadonlyArray<string> = Object.freeze([
  'src/app/about/page.tsx',
  'src/app/auth/signin/page.tsx',
  'src/app/brief/page.tsx',
  'src/app/content/page.tsx',
  'src/app/offline/page.tsx',
  'src/app/page.tsx',
  'src/app/privacy/page.tsx',
  'src/app/profile/page.tsx',
  'src/app/profile/settings/page.tsx',
  'src/app/profile/stats/page.tsx',
  'src/app/profile/support/page.tsx',
  'src/app/terms/page.tsx',
  'src/app/usmle/page.tsx',
  'src/app/usmle/step1/[chapter]/page.tsx',
  'src/app/usmle/step1/page.tsx',
  'src/app/usmle/step1/study/page.tsx',
]);

/** Non-API route handlers needed by the public application shell. */
export const PUBLIC_APP_HANDLER_ROUTE_PATHS: ReadonlyArray<string> = Object.freeze([
  'src/app/manifest.webmanifest/route.ts',
]);

/** Layout/error/loading modules that participate in a reviewed public page. */
export const PUBLIC_APP_SHELL_PATHS: ReadonlyArray<string> = Object.freeze([
  'src/app/error.tsx',
  'src/app/global-error.tsx',
  'src/app/layout.tsx',
  'src/app/loading.tsx',
  'src/app/not-found.tsx',
  'src/app/profile/layout.tsx',
  'src/app/profile/loading.tsx',
  'src/app/profile/stats/loading.tsx',
  'src/app/usmle/layout.tsx',
]);

/** Dynamic metadata endpoints exposed by Next's file conventions. */
export const PUBLIC_METADATA_ROUTE_PATHS: ReadonlyArray<string> = Object.freeze([
  'src/app/icon.tsx',
  'src/app/robots.ts',
]);

export const PROTECTED_PUBLIC_FALLBACKS: ReadonlyArray<Readonly<{
  path: string;
  licence: DistributionLicence;
  sha256: string;
}>> = [
  {
    path: 'next.config.ts',
    licence: 'MIT',
    sha256: '51db08707e0aa76ed85a273a01045e8e3398692d84c814dbbbbd5d215c8d27f8',
  },
  {
    path: 'README.md',
    licence: 'CC-BY-4.0',
    sha256: '9109ced81eec35fdbc2de90c67ade41fdb619a96b842ed7acf6d570556b21188',
  },
  {
    path: 'src/app/brief/page.tsx',
    licence: 'MIT',
    sha256: 'b437eb9d06a3ec34520d6dc238f9678038315d5ae6029fdcd59812e72e773fff',
  },
  {
    path: 'src/app/content/page.tsx',
    licence: 'MIT',
    sha256: 'b677a7de091a23eb9aa3fb40e92ed0caa955f78ec8067fa985cbc934e6079a8b',
  },
  {
    path: 'src/app/page.tsx',
    licence: 'MIT',
    sha256: 'dd4c229786ac63d1cda38c04f747ad09fc426f4b1e01d352e5857227a2817796',
  },
  {
    path: 'src/app/privacy/page.tsx',
    licence: 'MIT',
    sha256: 'd5aa11b9b658f3ee766219eb1b915e351bf862b8b90edffd217e0f499410be14',
  },
  {
    path: 'src/app/profile/settings/PersonalDocumentsDestination.tsx',
    licence: 'MIT',
    sha256: '830187374e382de53c897a2b1142f36cfa640885bb10c67ffe6438aec01f1e27',
  },
  {
    path: 'src/app/terms/page.tsx',
    licence: 'MIT',
    sha256: 'b3118009e4db7eadc439b9b3cef6268fb4d5049b0ffe3e30242b3da0d0652369',
  },
  {
    path: 'src/components/TermProvider.tsx',
    licence: 'MIT',
    sha256: 'ddc6376bdfca134831596b6a5a5ecf9fc581c42697179619a34b0b14b55df21f',
  },
  {
    path: 'src/components/Navigation.tsx',
    licence: 'MIT',
    sha256: 'dae6e91fae8540c946cfe7330d38e5bbf9d4c1df3d305046b13e77a81a735b90',
  },
  {
    path: 'src/components/content/AlgorithmSteps.tsx',
    licence: 'MIT',
    sha256: '0fd17c54eed235f78818f96c6e77dcf4460d51761a45325420e34efc32693a44',
  },
  {
    path: 'src/components/content/Citation.tsx',
    licence: 'MIT',
    sha256: '245c5c8fc98586a8a74e9ab2c38aadd9f2c9245b323c598eb85beea459e3dc7c',
  },
  {
    path: 'src/components/content/glossary-data.json',
    licence: 'CC-BY-4.0',
    sha256: 'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356',
  },
  {
    path: 'src/components/content/QuestionBankMCQ.tsx',
    licence: 'MIT',
    sha256: '12b2f15aec25cf72c96cd898ff1a4d78fbb3e989440c978cd10abbb65d053e09',
  },
  {
    path: 'src/components/offline/OfflineTabShell.tsx',
    licence: 'MIT',
    sha256: 'a4a201187b62947ea208618627d8e53dc3b7d68c028eac30b25d1f3c3b8b824f',
  },
  {
    path: 'src/components/ecg/index.ts',
    licence: 'MIT',
    sha256: '39af9cefb40e1d75e2a306eadd8f0199fb4399b5e44d1db7cd0b6bf338fc2aa3',
  },
  {
    path: 'src/components/exams/clinical-lesson-visuals.tsx',
    licence: 'MIT',
    sha256: '215eff7e3e3c9cc7295fcbd66d183720bd5f6a83e38cb3de3b9d22ba76c40f24',
  },
  {
    path: 'src/lib/content-index.ts',
    licence: 'CC-BY-4.0',
    sha256: '6f802f86263b2a6ae92d3e8fee33b17a0e0f3ca261a7f507eb4ff768b7ed06d8',
  },
  {
    path: 'src/hooks/useActiveModules.ts',
    licence: 'MIT',
    sha256: '7235024e8b748d2aaabc33d04bc4ea42e5d50d387897a3a2293b2947206c8b00',
  },
  {
    path: 'src/lib/current-study.ts',
    licence: 'MIT',
    sha256: '115ca29bb05f4a1c694e7ecb9ecfb976abaa680ef0c0a2311971f75ec36d7725',
  },
  {
    path: 'src/lib/curriculum/index.ts',
    licence: 'MIT',
    sha256: '3c0b0b032f90be3a1988d603fd279a048c045e2d16d907aca7bbd379d197d533',
  },
  {
    path: 'src/lib/deep-dive-cards-loaders.ts',
    licence: 'MIT',
    sha256: '9a7b38dc243523b3d37b61bf615aa96458c9df22fd3d6e89ea5c086fa27af01d',
  },
  {
    path: 'src/lib/deep-dive-cards-lookup.ts',
    licence: 'MIT',
    sha256: '8b060617133914006f0e32ca02b899c9606647b425d7e95d80bbc2d0751a7ef6',
  },
  {
    path: 'src/lib/deep-dive-cards-meta.ts',
    licence: 'MIT',
    sha256: '46b556b05913a53c9da6f988ef7da66128a4d93673fe80713a22b9b72b7b4148',
  },
  {
    path: 'src/lib/deep-dives.ts',
    licence: 'MIT',
    sha256: '7f2d224f4ba650aab9564e1f0f6119511c18c3586b0b3c6ae8565b9065a15300',
  },
  {
    path: 'src/lib/institution-rotations.ts',
    licence: 'MIT',
    sha256: 'c9229a0523993c323ed92c089b300e15fd433d8bb567bf9a1d0d839149d3eccc',
  },
  {
    path: 'src/lib/institution.ts',
    licence: 'MIT',
    sha256: 'c1e7a78f562734d85c1293964213aa78e07f5efafeae31ed11af4af20fac805f',
  },
  {
    path: 'src/lib/manifold/question-complexity.ts',
    licence: 'MIT',
    sha256: '77ee2b1e788e4300b4ebe9b90fac0876b6e315adab4bff7dd5a5caa91e8c54ba',
  },
  {
    path: 'src/lib/offline/fill.ts',
    licence: 'MIT',
    sha256: '4a4c6d2e4053f7dd11ca903659271bed634871f1d8cfc2277e525c3057653e9a',
  },
  {
    path: 'src/lib/offline/figures.ts',
    licence: 'MIT',
    sha256: '1a9da59b6a14c3230ec1a3842c1eb4a512093aa913d9ffef68fad70fedb16e99',
  },
  {
    path: 'src/lib/personal-decks.ts',
    licence: 'MIT',
    sha256: 'c7ff3a1b8db818bdda50258cb8d48cdf0226f0e059465f4ccc88dc05c3c82695',
  },
  {
    path: 'src/lib/questions/private-access-session.ts',
    licence: 'MIT',
    sha256: '7c473acf21555c63a1b704585441a0390b9087d7dffc52e371cfad17b55971d6',
  },
  {
    path: 'src/lib/questions/private-access.ts',
    licence: 'MIT',
    sha256: '9669e7c0d325f492a2649cbe12283ff7dcfec0e580ce238c811df2c3db91d39a',
  },
  {
    path: 'src/lib/review/scheduler-config.ts',
    licence: 'MIT',
    sha256: '7452f53ce80503fb5bd0ed42a87e177ac1851644002fd000ea284120e48c167a',
  },
  {
    path: 'src/lib/rotation-context.ts',
    licence: 'MIT',
    sha256: 'dbd501a12ed1c3d5116514b878139a8a7eb3e6582ffd13b64574f247aef3e56b',
  },
  {
    path: 'src/lib/rotation-labels.ts',
    licence: 'MIT',
    sha256: 'dab775fabfb3417e15d3c05438d8d207e561746f2ebe81955fa35ac7a0feb1cb',
  },
  {
    path: 'src/lib/rotation-metadata.json',
    licence: 'MIT',
    sha256: 'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356',
  },
  {
    path: 'src/lib/rotations.ts',
    licence: 'MIT',
    sha256: '1d9f5d2f04d4faf55a0ffff49f7bfb6a4a56add608c360d9107e5b66a5601fd4',
  },
  {
    path: 'src/lib/source-registry-data.json',
    licence: 'CC-BY-4.0',
    sha256: '37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570',
  },
  {
    path: 'src/lib/usmle/index.ts',
    licence: 'MIT',
    sha256: 'ccf75e465bf621c0923b16ee1ad5867613c5d78534946f5d103a1f5c5827f3e4',
  },
  {
    path: 'vercel.json',
    licence: 'MIT',
    sha256: '2d8782778385ffda0bc7ea0dd15da4bf0fbcd66840522d62271fc888d2ae9b65',
  },
  {
    path: 'vitest.setup.ts',
    licence: 'MIT',
    sha256: '08f69cd2e5cacc8adf532067f3e3218053decaf6562b906422240894728d23ac',
  },
];

const ACCEPTED_SOURCE_LICENCE_IDS = new Set([
  'cc-by-4.0',
  'cc-by-sa-4.0',
  'cc0-1.0',
  'us-gov',
]);

const PUBLIC_PACKAGE_SCRIPT_NAMES = new Set([
  'build',
  'build:isolated',
  'build:isolated:release',
  'build:release',
  'db:migrate:deploy',
  'db:migrate:status',
  'db:push',
  'db:seed',
  'db:seed:usmle-open',
  'db:studio',
  'dev',
  'foss:boundary:audit',
  'foss:boundary:write',
  'foss:export',
  'foss:test',
  'images:index',
  'images:index:offline',
  'images:index:release',
  'lint',
  'prebuild',
  'predev',
  'prefoss:test',
  'start',
  'test',
  'test:run',
  'typecheck:scripts',
  'usmle:corpus:audit',
  'usmle:corpus:release-gate',
  'usmle:corpus:seed:dry',
  'usmle:release:fingerprints:write',
  'usmle:reinforcement:audit',
  'usmle:reinforcement:repair:apply',
  'usmle:reinforcement:test',
  'usmle:serving-db:preflight',
]);

const POLICY_KEYS = new Set([
  'schemaVersion',
  'pathManifest',
  'includeRoots',
  'includeFiles',
  'excludePrefixes',
  'excludeFiles',
  'forbiddenPrefixes',
  'allowedTextExtensions',
  'allowedBinaryFiles',
  'licenceOverrides',
  'generatedTextFiles',
  'maximumFileBytes',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalRelativePath(value: string, label: string): string {
  if (!value || /[\u0000-\u001f\u007f]/.test(value) || value.includes('\\')) {
    throw new Error(`${label} must be a non-empty POSIX repo-relative path`);
  }
  if (path.posix.isAbsolute(value)) {
    throw new Error(`${label} must be repo-relative`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} is not canonical`);
  }
  return value;
}

function stringArray(value: unknown, label: string, options?: { paths?: boolean }): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  const result = value.map((entry) => options?.paths
    ? canonicalRelativePath(entry as string, label)
    : entry as string);
  if (new Set(result).size !== result.length) {
    throw new Error(`${label} contains duplicates`);
  }
  return result;
}

function validateTextExtensions(extensions: string[]): void {
  for (const extension of extensions) {
    if (extension !== '' && !/^\.[a-z0-9]+$/.test(extension)) {
      throw new Error('allowedTextExtensions entries must be empty or lowercase dot extensions');
    }
  }
}

function parseDistributionLicence(value: unknown, label: string): DistributionLicence {
  if (
    value !== 'MIT'
    && value !== 'CC-BY-4.0'
    && value !== 'OFL-1.1'
    && value !== 'MIXED-PER-SOURCE'
  ) {
    throw new Error(`${label} is unsupported`);
  }
  return value;
}

function parseAllowedBinaryFiles(value: unknown): AllowedBinaryFile[] {
  if (!Array.isArray(value)) throw new Error('allowedBinaryFiles must be an array');
  const result = value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`allowedBinaryFiles[${index}] must be an object`);
    const keys = Object.keys(entry);
    const expected = ['licence', 'notice', 'path', 'sha256'];
    if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
      throw new Error(`allowedBinaryFiles[${index}] has unknown or missing keys`);
    }
    if (typeof entry.path !== 'string' || typeof entry.notice !== 'string') {
      throw new Error(`allowedBinaryFiles[${index}] path and notice must be strings`);
    }
    const filePath = canonicalRelativePath(entry.path, `allowedBinaryFiles[${index}].path`);
    const notice = canonicalRelativePath(entry.notice, `allowedBinaryFiles[${index}].notice`);
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`allowedBinaryFiles[${index}].sha256 must be lowercase SHA-256`);
    }
    const licence = parseDistributionLicence(
      entry.licence,
      `allowedBinaryFiles[${index}].licence`,
    );
    return {
      path: filePath,
      sha256: entry.sha256,
      licence,
      notice,
    };
  });
  const paths = result.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) throw new Error('allowedBinaryFiles contains duplicate paths');
  return result;
}

function parseLicenceOverrides(value: unknown): LicenceOverride[] {
  if (!Array.isArray(value)) throw new Error('licenceOverrides must be an array');
  const result = value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`licenceOverrides[${index}] must be an object`);
    const keys = Object.keys(entry);
    const expected = ['licence', 'path'];
    if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
      throw new Error(`licenceOverrides[${index}] has unknown or missing keys`);
    }
    if (typeof entry.path !== 'string') {
      throw new Error(`licenceOverrides[${index}].path must be a string`);
    }
    return {
      path: canonicalRelativePath(entry.path, `licenceOverrides[${index}].path`),
      licence: parseDistributionLicence(entry.licence, `licenceOverrides[${index}].licence`),
    };
  });
  const paths = result.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) throw new Error('licenceOverrides contains duplicate paths');
  return result;
}

function parseGeneratedTextFiles(value: unknown): GeneratedTextFile[] {
  if (!Array.isArray(value)) throw new Error('generatedTextFiles must be an array');
  const result = value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`generatedTextFiles[${index}] must be an object`);
    const keys = Object.keys(entry);
    const expected = ['licence', 'path', 'text'];
    if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
      throw new Error(`generatedTextFiles[${index}] has unknown or missing keys`);
    }
    if (typeof entry.path !== 'string' || typeof entry.text !== 'string') {
      throw new Error(`generatedTextFiles[${index}] path and text must be strings`);
    }
    const licence = parseDistributionLicence(
      entry.licence,
      `generatedTextFiles[${index}].licence`,
    );
    return {
      path: canonicalRelativePath(entry.path, `generatedTextFiles[${index}].path`),
      text: entry.text,
      licence,
    };
  });
  const paths = result.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) throw new Error('generatedTextFiles contains duplicate paths');
  return result;
}

function parseDistributionPolicy(raw: unknown): DistributionPolicy {
  if (!isRecord(raw)) throw new Error('distribution policy must be an object');
  const unknownKeys = Object.keys(raw).filter((key) => !POLICY_KEYS.has(key));
  const missingKeys = [...POLICY_KEYS].filter((key) => !(key in raw));
  if (unknownKeys.length > 0 || missingKeys.length > 0) {
    throw new Error(
      `distribution policy keys are invalid (unknown: ${unknownKeys.join(', ') || 'none'}; `
      + `missing: ${missingKeys.join(', ') || 'none'})`,
    );
  }
  if (raw.schemaVersion !== 1) throw new Error('distribution policy schemaVersion must be 1');
  if (!Number.isInteger(raw.maximumFileBytes) || Number(raw.maximumFileBytes) <= 0) {
    throw new Error('maximumFileBytes must be a positive integer');
  }
  if (typeof raw.pathManifest !== 'string') {
    throw new Error('pathManifest must be a string');
  }

  const policy: DistributionPolicy = {
    schemaVersion: 1,
    pathManifest: canonicalRelativePath(raw.pathManifest, 'pathManifest'),
    includeRoots: stringArray(raw.includeRoots, 'includeRoots', { paths: true }),
    includeFiles: stringArray(raw.includeFiles, 'includeFiles', { paths: true }),
    excludePrefixes: stringArray(raw.excludePrefixes, 'excludePrefixes', { paths: true }),
    excludeFiles: stringArray(raw.excludeFiles, 'excludeFiles', { paths: true }),
    forbiddenPrefixes: stringArray(raw.forbiddenPrefixes, 'forbiddenPrefixes', { paths: true }),
    allowedTextExtensions: stringArray(raw.allowedTextExtensions, 'allowedTextExtensions'),
    allowedBinaryFiles: parseAllowedBinaryFiles(raw.allowedBinaryFiles),
    licenceOverrides: parseLicenceOverrides(raw.licenceOverrides),
    generatedTextFiles: parseGeneratedTextFiles(raw.generatedTextFiles),
    maximumFileBytes: Number(raw.maximumFileBytes),
  };
  validateTextExtensions(policy.allowedTextExtensions);
  for (const selectedPath of [...policy.includeRoots, ...policy.includeFiles]) {
    if (isForbidden(selectedPath, policy)) {
      throw new Error(`included path is forbidden by policy: ${selectedPath}`);
    }
  }
  for (const selectedRoot of policy.includeRoots) {
    if (isExcluded(selectedRoot, policy)) {
      throw new Error(`included root is also excluded by policy: ${selectedRoot}`);
    }
  }
  for (const selectedFile of policy.includeFiles) {
    if (isExcluded(selectedFile, policy)) {
      throw new Error(`included file is also excluded by policy: ${selectedFile}`);
    }
  }
  for (const classified of [...policy.licenceOverrides, ...policy.generatedTextFiles]) {
    if (isForbidden(classified.path, policy)) {
      throw new Error(`classified path is forbidden by policy: ${classified.path}`);
    }
  }
  const binaryPaths = new Set(policy.allowedBinaryFiles.map((entry) => entry.path));
  for (const override of policy.licenceOverrides) {
    if (binaryPaths.has(override.path)) {
      throw new Error(`licence override duplicates an allowed binary classification: ${override.path}`);
    }
  }
  return policy;
}

export function loadDistributionPolicy(
  repoRoot: string,
  policyPath = POLICY_PATH,
): DistributionPolicy {
  const canonicalPolicyPath = canonicalRelativePath(policyPath, 'policyPath');
  const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, canonicalPolicyPath), 'utf8')) as unknown;
  return parseDistributionPolicy(raw);
}

function matchesPrefix(filePath: string, prefix: string): boolean {
  return filePath === prefix || filePath.startsWith(`${prefix}/`);
}

function pathsCollide(left: string, right: string): boolean {
  return matchesPrefix(left, right) || matchesPrefix(right, left);
}

function pathsCollidePortably(left: string, right: string): boolean {
  return pathsCollide(left.toLowerCase(), right.toLowerCase());
}

function isImplicitlyExcludedTest(filePath: string, policy: DistributionPolicy): boolean {
  if (policy.includeFiles.includes(filePath)) return false;
  return /(?:^|\/)[^/]+(?:\.integration)?\.test\.tsx?$/.test(filePath);
}

function isExcluded(filePath: string, policy: DistributionPolicy): boolean {
  return policy.excludeFiles.includes(filePath)
    || policy.excludePrefixes.some((prefix) => matchesPrefix(filePath, prefix))
    || isImplicitlyExcludedTest(filePath, policy);
}

function isForbidden(filePath: string, policy: DistributionPolicy): boolean {
  return policy.forbiddenPrefixes.some((prefix) => matchesPrefix(filePath, prefix));
}

function issue(
  code: DistributionIssueCode,
  filePath: string,
  detail: string,
): DistributionIssue {
  return { code, path: filePath, detail };
}

function walkCandidateRoot(
  repoRoot: string,
  relativeRoot: string,
  policy: DistributionPolicy,
  selected: Set<string>,
  issues: DistributionIssue[],
): void {
  if (isExcluded(relativeRoot, policy)) return;
  const absolute = path.join(repoRoot, relativeRoot);
  if (!fs.existsSync(absolute)) {
    issues.push(issue('explicit-path-missing', relativeRoot, 'included root is missing'));
    return;
  }
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    issues.push(issue('selected-symlink', relativeRoot, 'included roots may not be symlinks'));
    return;
  }
  if (!stat.isDirectory()) {
    issues.push(issue('explicit-path-missing', relativeRoot, 'included root is not a directory'));
    return;
  }

  for (const name of fs.readdirSync(absolute).sort()) {
    const relative = path.posix.join(relativeRoot, name);
    if (isExcluded(relative, policy)) continue;
    const child = path.join(repoRoot, relative);
    const childStat = fs.lstatSync(child);
    if (childStat.isSymbolicLink()) {
      issues.push(issue('selected-symlink', relative, 'selected paths may not be symlinks'));
    } else if (childStat.isDirectory()) {
      walkCandidateRoot(repoRoot, relative, policy, selected, issues);
    } else if (childStat.isFile()) {
      selected.add(relative);
    } else {
      issues.push(issue('unsupported-file-type', relative, 'selected path is not a regular file'));
    }
  }
}

function discoverCandidatePaths(
  repoRoot: string,
  policy: DistributionPolicy,
): CandidateDiscovery {
  const selected = new Set<string>();
  const issues: DistributionIssue[] = [];
  for (const root of policy.includeRoots) {
    walkCandidateRoot(repoRoot, root, policy, selected, issues);
  }
  for (const filePath of policy.includeFiles) {
    if (isExcluded(filePath, policy)) continue;
    const absolute = path.join(repoRoot, filePath);
    if (!fs.existsSync(absolute)) {
      issues.push(issue('explicit-path-missing', filePath, 'explicitly included file is missing'));
      continue;
    }
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      issues.push(issue('selected-symlink', filePath, 'selected paths may not be symlinks'));
    } else if (!stat.isFile()) {
      issues.push(issue('unsupported-file-type', filePath, 'selected path is not a regular file'));
    } else {
      selected.add(filePath);
    }
  }
  const paths = [...selected].sort();
  for (let index = 0; index < paths.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < paths.length; otherIndex += 1) {
      if (
        paths[index] !== paths[otherIndex]
        && paths[index].toLowerCase() === paths[otherIndex].toLowerCase()
      ) {
        issues.push(issue(
          'portable-path-collision',
          paths[otherIndex],
          `candidate collides case-insensitively with ${paths[index]}`,
        ));
      }
    }
  }
  return { paths, issues };
}

function sha256(buffer: Buffer | string): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function licenceForPath(
  filePath: string,
  policy: DistributionPolicy,
): DistributionLicence {
  const binary = policy.allowedBinaryFiles.find((entry) => entry.path === filePath);
  if (binary) return binary.licence;
  const override = policy.licenceOverrides.find((entry) => entry.path === filePath);
  if (override) return override.licence;
  if (matchesPrefix(filePath, 'open-content')) return 'CC-BY-4.0';
  if (filePath === 'THIRD_PARTY_LICENSES/Geist-OFL-1.1.txt') return 'OFL-1.1';
  return 'MIT';
}

function requiresExplicitDocumentLicence(filePath: string): boolean {
  return matchesPrefix(filePath, 'docs')
    || filePath === 'CONTRIBUTING.md'
    || filePath === 'LICENSE-CONTENT.md';
}

function credentialFinding(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    for (const candidate of SECRET_PATTERNS) {
      if (candidate.pattern.test(line)) return candidate.name;
    }
  }
  return null;
}

function learnerIdentifierFinding(text: string): string | null {
  // The public author's exact credit is content provenance, not learner data.
  // Permit it only as the complete value of an `attribution` field so a longer
  // learner-specific string cannot hide behind the exception.
  const withoutAuthorAttribution = text.replace(
    /(\b["']?attribution["']?\s*:\s*)(["'])([^"'\r\n]*)\2/g,
    (match, prefix: string, quote: string, value: string) => (
      value === EXACT_PUBLIC_AUTHOR_ATTRIBUTION
        ? `${prefix}${quote}[public-author]${quote}`
        : match
    ),
  );
  for (const line of withoutAuthorAttribution.split(/\r?\n/)) {
    for (const candidate of LEARNER_IDENTIFIER_PATTERNS) {
      if (candidate.pattern.test(line)) return candidate.name;
    }
  }
  return null;
}

function isAcceptedSourceLicence(licenceId: string, licenceUrl: string): boolean {
  const id = licenceId.trim().toLowerCase();
  if (!ACCEPTED_SOURCE_LICENCE_IDS.has(id)) return false;
  let url: URL;
  try {
    url = new URL(licenceUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const hostname = url.hostname.toLowerCase();
  if (id === 'us-gov') return hostname === 'gov' || hostname.endsWith('.gov');
  if (hostname !== 'creativecommons.org') return false;
  const normalizedPath = url.pathname.replace(/\/+$/, '').toLowerCase();
  if (id === 'cc0-1.0') return normalizedPath === '/publicdomain/zero/1.0';
  if (id === 'cc-by-4.0') return normalizedPath === '/licenses/by/4.0';
  return normalizedPath === '/licenses/by-sa/4.0';
}

function perSourceRightsIssues(
  filePath: string,
  text: string,
  policy: DistributionPolicy,
): DistributionIssue[] {
  const classification = policy.licenceOverrides.find((entry) => entry.path === filePath);
  if (classification?.licence !== 'MIXED-PER-SOURCE') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return [issue(
      'invalid-per-source-rights',
      filePath,
      'per-source rights file is not valid JSON',
    )];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.sources) || parsed.sources.length === 0) {
    return [issue(
      'invalid-per-source-rights',
      filePath,
      'per-source rights file must contain a non-empty sources array',
    )];
  }

  const issues: DistributionIssue[] = [];
  const sourceIds = new Set<string>();
  parsed.sources.forEach((source, index) => {
    if (!isRecord(source) || !isRecord(source.licence)) {
      issues.push(issue(
        'invalid-per-source-rights',
        filePath,
        `source entry ${index} has no explicit licence record`,
      ));
      return;
    }
    const licenceClass = source.licence.cls;
    const licenceId = source.licence.id;
    const licenceUrl = source.licence.url;
    const attribution = source.attribution;
    const sourceId = source.id;
    const canonicalUrl = source.canonicalUrl;
    const passages = source.passages;
    const acceptedLicence = typeof licenceId === 'string'
      && typeof licenceUrl === 'string'
      && isAcceptedSourceLicence(licenceId, licenceUrl);
    let canonicalUrlValid = false;
    if (typeof canonicalUrl === 'string') {
      try {
        canonicalUrlValid = new URL(canonicalUrl).protocol === 'https:';
      } catch {
        canonicalUrlValid = false;
      }
    }
    const passageIds = new Set<string>();
    const passagesValid = Array.isArray(passages)
      && passages.length > 0
      && passages.every((passage) => {
        if (!isRecord(passage)) return false;
        const passageId = passage.id;
        const valid = typeof passageId === 'string'
          && passageId.trim().length > 0
          && !passageIds.has(passageId)
          && typeof passage.locator === 'string'
          && passage.locator.trim().length > 0
          && typeof passage.quote === 'string'
          && passage.quote.trim().length > 0;
        if (typeof passageId === 'string') passageIds.add(passageId);
        return valid;
      });
    const sourceIdValid = typeof sourceId === 'string'
      && sourceId.trim().length > 0
      && !sourceIds.has(sourceId);
    if (typeof sourceId === 'string') sourceIds.add(sourceId);
    if (
      licenceClass !== 'foss'
      || typeof licenceId !== 'string'
      || licenceId.trim().length === 0
      || !acceptedLicence
      || typeof attribution !== 'string'
      || attribution.trim().length === 0
      || !sourceIdValid
      || !canonicalUrlValid
      || !passagesValid
    ) {
      issues.push(issue(
        licenceClass === 'verify' || licenceClass === 'unknown'
          ? 'non-foss-source-text'
          : 'invalid-per-source-rights',
        filePath,
        `source entry ${index} lacks unique source/passage IDs, HTTPS source/rights URLs, attribution, or exact passage metadata`,
      ));
    }
  });
  return issues;
}

function openQuestionRightsIssues(filePath: string, text: string): DistributionIssue[] {
  if (!/^open-content\/usmle\/step1\/questions\/.+\.json$/.test(filePath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return [issue(
      'invalid-open-content-rights',
      filePath,
      'open question is not valid JSON',
    )];
  }
  if (!isRecord(parsed) || !isRecord(parsed.publicUsmle)) {
    return [issue(
      'invalid-open-content-rights',
      filePath,
      'open question has no public rights envelope',
    )];
  }
  const itemText = parsed.publicUsmle.itemText;
  const evidence = parsed.publicUsmle.evidence;
  const itemRightsValid = isRecord(itemText)
    && itemText.licence === 'CC-BY-4.0'
    && typeof itemText.attribution === 'string'
    && itemText.attribution.trim().length > 0;
  const evidenceRightsValid = isRecord(evidence)
    && isRecord(evidence.licence)
    && evidence.licence.cls === 'foss'
    && typeof evidence.licence.id === 'string'
    && ACCEPTED_SOURCE_LICENCE_IDS.has(evidence.licence.id.trim().toLowerCase());
  if (!itemRightsValid || !evidenceRightsValid) {
    return [issue(
      'invalid-open-content-rights',
      filePath,
      'open question lacks explicit CC BY item rights or an accepted FOSS evidence class',
    )];
  }
  return [];
}

function openContentCrossReferenceIssues(
  inspected: ReadonlyMap<string, InspectedFile>,
): DistributionIssue[] {
  const registryPath = 'open-content/usmle/step1/sources.json';
  const registryFile = inspected.get(registryPath);
  const questionPaths = [...inspected.keys()].filter((filePath) => (
    /^open-content\/usmle\/step1\/questions\/.+\.json$/.test(filePath)
  ));
  if (questionPaths.length === 0) return [];
  if (!registryFile) {
    return [issue(
      'invalid-open-content-rights',
      registryPath,
      'open questions are selected without their source registry',
    )];
  }

  let registry: unknown;
  try {
    registry = JSON.parse(registryFile.buffer.toString('utf8')) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(registry) || !Array.isArray(registry.sources)) return [];

  const sources = new Map<string, {
    licenceClass: unknown;
    licenceId: unknown;
    passages: Set<string>;
  }>();
  for (const source of registry.sources) {
    if (!isRecord(source) || typeof source.id !== 'string' || !isRecord(source.licence)) {
      continue;
    }
    const passages = new Set<string>();
    if (Array.isArray(source.passages)) {
      for (const passage of source.passages) {
        if (isRecord(passage) && typeof passage.id === 'string') passages.add(passage.id);
      }
    }
    sources.set(source.id, {
      licenceClass: source.licence.cls,
      licenceId: source.licence.id,
      passages,
    });
  }

  const issues: DistributionIssue[] = [];
  for (const filePath of questionPaths.sort()) {
    let question: unknown;
    try {
      question = JSON.parse(inspected.get(filePath)!.buffer.toString('utf8')) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(question) || !isRecord(question.publicUsmle)) continue;
    const evidence = question.publicUsmle.evidence;
    if (!isRecord(evidence) || !isRecord(evidence.licence)) continue;
    const sourceId = evidence.sourceId;
    const passageId = evidence.passageId;
    const source = typeof sourceId === 'string' ? sources.get(sourceId) : undefined;
    const citation = typeof sourceId === 'string' && typeof passageId === 'string'
      ? `${sourceId}#${passageId}`
      : null;
    if (
      evidence.kind !== 'passage'
      || !source
      || typeof passageId !== 'string'
      || !source.passages.has(passageId)
      || evidence.licence.cls !== source.licenceClass
      || evidence.licence.id !== source.licenceId
      || question.cite !== citation
    ) {
      issues.push(issue(
        'invalid-open-content-rights',
        filePath,
        'question evidence does not resolve exactly to the selected source registry and matching per-source licence',
      ));
    }
  }
  return issues;
}

function publicDistributionMetadataIssues(
  inspected: ReadonlyMap<string, InspectedFile>,
  policy: DistributionPolicy,
): DistributionIssue[] {
  const packageDefinition = policy.generatedTextFiles.find((entry) => (
    entry.path === 'package.json'
  ));
  const workflowDefinition = policy.generatedTextFiles.find((entry) => (
    entry.path === '.github/workflows/ci.yml'
  ));
  if (!packageDefinition) {
    if (!inspected.has('package-lock.json')) return [];
    return [issue(
      'invalid-public-package',
      'package.json',
      'public package.json must be an explicit generated file',
    )];
  }

  let publicPackage: unknown;
  try {
    publicPackage = JSON.parse(packageDefinition.text) as unknown;
  } catch {
    return [issue(
      'invalid-public-package',
      'package.json',
      'generated public package.json is not valid JSON',
    )];
  }
  if (!isRecord(publicPackage) || !isRecord(publicPackage.scripts)) {
    return [issue(
      'invalid-public-package',
      'package.json',
      'generated public package.json has no scripts object',
    )];
  }

  const issues: DistributionIssue[] = [];
  const scriptEntries = Object.entries(publicPackage.scripts);
  const scriptNames = new Set(scriptEntries.map(([name]) => name));
  if (
    scriptNames.size !== PUBLIC_PACKAGE_SCRIPT_NAMES.size
    || [...PUBLIC_PACKAGE_SCRIPT_NAMES].some((name) => !scriptNames.has(name))
  ) {
    issues.push(issue(
      'invalid-public-package',
      'package.json',
      'public scripts differ from the minimal reviewed command set',
    ));
  }

  const lockFile = inspected.get('package-lock.json');
  if (!lockFile) {
    issues.push(issue(
      'invalid-public-package',
      'package-lock.json',
      'public package requires its selected lockfile',
    ));
  } else {
    try {
      const lock = JSON.parse(lockFile.buffer.toString('utf8')) as unknown;
      const rootPackage = isRecord(lock)
        && isRecord(lock.packages)
        && isRecord(lock.packages[''])
        ? lock.packages['']
        : null;
      if (
        !rootPackage
        || publicPackage.name !== rootPackage.name
        || publicPackage.version !== rootPackage.version
        || publicPackage.license !== rootPackage.license
        || !isDeepStrictEqual(publicPackage.engines, rootPackage.engines)
        || !isDeepStrictEqual(publicPackage.dependencies, rootPackage.dependencies)
        || !isDeepStrictEqual(publicPackage.devDependencies, rootPackage.devDependencies)
      ) {
        issues.push(issue(
          'invalid-public-package',
          'package.json',
          'public package metadata or dependencies differ from the selected lockfile root',
        ));
      }
    } catch {
      issues.push(issue(
        'invalid-public-package',
        'package-lock.json',
        'selected lockfile is not valid JSON',
      ));
    }
  }

  const availablePaths = new Set([
    ...inspected.keys(),
    ...policy.generatedTextFiles.map((entry) => entry.path),
  ]);
  const packageDependencies = {
    ...(isRecord(publicPackage.dependencies) ? publicPackage.dependencies : {}),
    ...(isRecord(publicPackage.devDependencies) ? publicPackage.devDependencies : {}),
  };
  const packageBinaryDependencies: Record<string, string> = {
    eslint: 'eslint',
    next: 'next',
    prisma: 'prisma',
    tsc: 'typescript',
    vitest: 'vitest',
  };
  const systemCommands = new Set(['node', 'npm', 'sh']);
  const pathPattern = /(?:^|[\s'"])([A-Za-z0-9@_./\-[\]]+\.(?:js|json|mjs|sh|ts|tsx))(?=$|[\s'"])/g;
  for (const [name, rawCommand] of scriptEntries) {
    if (typeof rawCommand !== 'string' || rawCommand.trim().length === 0) {
      issues.push(issue(
        'invalid-public-package',
        'package.json',
        `public script ${name} is not a non-empty string`,
      ));
      continue;
    }
    if (
      /\bnpx\b|(?:^|[\s'"])question-bank\/|scripts\/(?:anki-import|archive|personal)|audit:tooling-contract|seed-private/i
        .test(rawCommand)
    ) {
      issues.push(issue(
        'invalid-public-package',
        'package.json',
        `public script ${name} names a non-public or unpinned command surface`,
      ));
    }
    for (const match of rawCommand.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)) {
      if (!scriptNames.has(match[1])) {
        issues.push(issue(
          'invalid-public-package',
          'package.json',
          `public script ${name} calls missing script ${match[1]}`,
        ));
      }
    }
    for (const match of rawCommand.matchAll(pathPattern)) {
      if (!availablePaths.has(match[1])) {
        issues.push(issue(
          'invalid-public-package',
          'package.json',
          `public script ${name} references unexported path ${match[1]}`,
        ));
      }
    }
    for (const segment of rawCommand.split(/\s*&&\s*/)) {
      const tokens = segment.trim().split(/\s+/);
      while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
      const command = tokens[0];
      if (!command) continue;
      const dependency = packageBinaryDependencies[command];
      if (!systemCommands.has(command) && (!dependency || !(dependency in packageDependencies))) {
        issues.push(issue(
          'invalid-public-package',
          'package.json',
          `public script ${name} starts an unavailable command ${command}`,
        ));
      }
    }
  }

  const markdownFiles = [
    ...[...inspected.entries()]
      .filter(([filePath]) => filePath.endsWith('.md'))
      .map(([, file]) => file.buffer.toString('utf8')),
    ...policy.generatedTextFiles
      .filter((entry) => entry.path.endsWith('.md'))
      .map((entry) => entry.text),
  ];
  for (const markdown of markdownFiles) {
    for (const match of markdown.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)) {
      if (!scriptNames.has(match[1])) {
        issues.push(issue(
          'invalid-public-package',
          'package.json',
          `exported documentation advertises missing script ${match[1]}`,
        ));
      }
    }
  }

  if (!workflowDefinition) {
    issues.push(issue(
      'invalid-public-workflow',
      '.github/workflows/ci.yml',
      'public distribution has no generated CI workflow',
    ));
  } else {
    const requiredWorkflowFragments = [
      'node-version-file: .nvmrc',
      'npm ci',
      'scripts/foss/distribution.ts',
      'npm run foss:boundary:audit',
      'npm run foss:export',
      'npm run foss:test',
      'npm run typecheck:scripts',
      'npm run lint',
      'npm run usmle:corpus:release-gate',
      'npm run usmle:corpus:seed:dry',
      'npm run build',
    ];
    if (
      requiredWorkflowFragments.some((fragment) => !workflowDefinition.text.includes(fragment))
      || /question-bank|DATABASE_URL_LOCAL|pull_request_target|npm run [^\n]*(?:deploy|repair:apply)/i
        .test(workflowDefinition.text)
    ) {
      issues.push(issue(
        'invalid-public-workflow',
        '.github/workflows/ci.yml',
        'public workflow is missing a required clean-artifact check or names a private/mutating surface',
      ));
    }
  }
  return issues;
}

function inspectFile(
  repoRoot: string,
  filePath: string,
  policy: DistributionPolicy,
): { inspected: InspectedFile | null; issues: DistributionIssue[] } {
  const issues: DistributionIssue[] = [];
  if (isForbidden(filePath, policy)) {
    issues.push(issue('forbidden-candidate-path', filePath, 'path is under a forbidden distribution root'));
  }
  const absolute = path.join(repoRoot, filePath);
  const initialStat = fs.lstatSync(absolute);
  if (initialStat.isSymbolicLink() || !initialStat.isFile()) {
    issues.push(issue('selected-symlink', filePath, 'selected path is not a regular non-symlink file'));
    return { inspected: null, issues };
  }
  const realRepoRoot = fs.realpathSync(repoRoot);
  const expectedRealPath = path.resolve(realRepoRoot, filePath);
  const initialRealPath = fs.realpathSync(absolute);
  if (initialRealPath !== expectedRealPath) {
    issues.push(issue(
      'selected-symlink',
      filePath,
      'selected path traverses an intermediate symlink',
    ));
    return { inspected: null, issues };
  }
  let descriptor: number | null = null;
  let buffer: Buffer;
  let openedStat: fs.Stats;
  try {
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    openedStat = fs.fstatSync(descriptor);
    if (
      !openedStat.isFile()
      || openedStat.dev !== initialStat.dev
      || openedStat.ino !== initialStat.ino
    ) {
      issues.push(issue(
        'selected-symlink',
        filePath,
        'selected file changed while it was being opened',
      ));
      return { inspected: null, issues };
    }
    buffer = fs.readFileSync(descriptor);
  } catch {
    issues.push(issue(
      'selected-symlink',
      filePath,
      'selected file could not be opened without following links',
    ));
    return { inspected: null, issues };
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
  try {
    const finalStat = fs.lstatSync(absolute);
    const finalRealPath = fs.realpathSync(absolute);
    if (
      finalStat.isSymbolicLink()
      || !finalStat.isFile()
      || finalStat.dev !== openedStat.dev
      || finalStat.ino !== openedStat.ino
      || finalRealPath !== initialRealPath
    ) {
      issues.push(issue(
        'selected-symlink',
        filePath,
        'selected file changed while it was being read',
      ));
      return { inspected: null, issues };
    }
  } catch {
    issues.push(issue(
      'selected-symlink',
      filePath,
      'selected file disappeared while it was being read',
    ));
    return { inspected: null, issues };
  }
  if (buffer.byteLength > policy.maximumFileBytes) {
    issues.push(issue(
      'file-too-large',
      filePath,
      `file is ${buffer.byteLength} bytes; limit is ${policy.maximumFileBytes}`,
    ));
  }

  const allowedBinary = policy.allowedBinaryFiles.find((entry) => entry.path === filePath);
  if (allowedBinary) {
    const digest = sha256(buffer);
    if (digest !== allowedBinary.sha256) {
      issues.push(issue(
        'third-party-binary-hash-mismatch',
        filePath,
        'binary bytes differ from the reviewed policy hash',
      ));
    }
    if (!fs.existsSync(path.join(repoRoot, allowedBinary.notice))) {
      issues.push(issue(
        'third-party-notice-missing',
        filePath,
        `required notice is missing: ${allowedBinary.notice}`,
      ));
    }
    return {
      inspected: {
        bytes: buffer.byteLength,
        buffer,
        licence: allowedBinary.licence,
        mode: openedStat.mode & 0o111 ? '0755' : '0644',
        sha256: digest,
      },
      issues,
    };
  }

  if (
    requiresExplicitDocumentLicence(filePath)
    && !policy.licenceOverrides.some((entry) => entry.path === filePath)
  ) {
    issues.push(issue(
      'non-foss-source-text',
      filePath,
      'selected document requires an exact reviewed licence override; directory-wide relicensing is forbidden',
    ));
  }

  const extension = path.posix.extname(filePath).toLowerCase();
  if (!policy.allowedTextExtensions.includes(extension) || buffer.includes(0)) {
    issues.push(issue(
      'unsupported-file-type',
      filePath,
      'file is not an explicitly allowed text type or reviewed binary',
    ));
  } else {
    let text: string | null = null;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      issues.push(issue(
        'unsupported-file-type',
        filePath,
        'file is not valid UTF-8 text',
      ));
    }
    if (text !== null) {
      const finding = credentialFinding(text);
      if (finding) {
        issues.push(issue(
          'credential-shaped-text',
          filePath,
          `matched ${finding}; file content is intentionally omitted from reports`,
        ));
      }
      const learnerIdentifier = learnerIdentifierFinding(text);
      if (learnerIdentifier) {
        issues.push(issue(
          'learner-identifier',
          filePath,
          `matched ${learnerIdentifier}; file content is intentionally omitted from reports`,
        ));
      }
      issues.push(...perSourceRightsIssues(filePath, text, policy));
      issues.push(...openQuestionRightsIssues(filePath, text));
    }
  }

  return {
    inspected: {
      bytes: buffer.byteLength,
      buffer,
      licence: licenceForPath(filePath, policy),
      mode: openedStat.mode & 0o111 ? '0755' : '0644',
      sha256: sha256(buffer),
    },
    issues,
  };
}

function parseReviewedPathManifestText(
  raw: string,
  policy: DistributionPolicy,
): { paths: string[]; issues: DistributionIssue[] } {
  const paths: string[] = [];
  const issues: DistributionIssue[] = [];
  try {
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      paths.push(canonicalRelativePath(line, 'reviewed path'));
    }
  } catch (error) {
    issues.push(issue(
      'invalid-path-manifest',
      policy.pathManifest,
      error instanceof Error ? error.message : 'invalid reviewed path',
    ));
  }
  if (new Set(paths).size !== paths.length) {
    issues.push(issue('invalid-path-manifest', policy.pathManifest, 'reviewed paths contain duplicates'));
  }
  const sorted = [...new Set(paths)].sort();
  if (JSON.stringify(paths) !== JSON.stringify(sorted)) {
    issues.push(issue(
      'path-manifest-not-sorted',
      policy.pathManifest,
      'reviewed paths must be unique and sorted',
    ));
  }
  return { paths: sorted, issues };
}

function parseReviewedPathManifest(
  repoRoot: string,
  policy: DistributionPolicy,
): { paths: string[]; issues: DistributionIssue[] } {
  const manifestPath = path.join(repoRoot, policy.pathManifest);
  if (!fs.existsSync(manifestPath)) {
    return {
      paths: [],
      issues: [issue('invalid-path-manifest', policy.pathManifest, 'reviewed path manifest is missing')],
    };
  }
  return parseReviewedPathManifestText(fs.readFileSync(manifestPath, 'utf8'), policy);
}

function sortedIssues(issues: DistributionIssue[]): DistributionIssue[] {
  return [...issues].sort((left, right) =>
    left.path.localeCompare(right.path) || left.code.localeCompare(right.code));
}

function binaryPolicyIssues(
  candidates: Set<string>,
  policy: DistributionPolicy,
): DistributionIssue[] {
  const issues: DistributionIssue[] = [];
  for (const binary of policy.allowedBinaryFiles) {
    if (!candidates.has(binary.path)) {
      issues.push(issue(
        'explicit-path-missing',
        binary.path,
        'reviewed binary is not selected by the current policy',
      ));
    }
    if (!candidates.has(binary.notice)) {
      issues.push(issue(
        'third-party-notice-missing',
        binary.path,
        `required notice is not selected: ${binary.notice}`,
      ));
    }
  }
  for (const override of policy.licenceOverrides) {
    if (!candidates.has(override.path)) {
      issues.push(issue(
        'explicit-path-missing',
        override.path,
        'licence override is not selected by the current policy',
      ));
    }
  }
  return issues;
}

function publicApiRouteSurfaceIssues(
  paths: Iterable<string>,
  policy: DistributionPolicy,
): DistributionIssue[] {
  // Unit-test fixtures use other roots and intentionally do not model the app.
  if (!policy.includeRoots.includes('src')) return [];

  const expected = new Set(PUBLIC_API_ROUTE_PATHS);
  const selected = new Set(
    [...paths].filter((filePath) => (
      /^src\/app\/api\/.+\/route\.(?:js|jsx|ts|tsx)$/.test(filePath)
    )),
  );
  const issues: DistributionIssue[] = [];
  for (const filePath of selected) {
    if (!expected.has(filePath)) {
      issues.push(issue(
        'non-foss-source-text',
        filePath,
        'public API route is outside the exact reviewed Step 1 allowlist',
      ));
    }
  }
  for (const filePath of expected) {
    if (!selected.has(filePath)) {
      issues.push(issue(
        'explicit-path-missing',
        filePath,
        'required public API route is absent from the exact Step 1 allowlist surface',
      ));
    }
  }
  return issues;
}

function publicPageRouteSurfaceIssues(
  paths: Iterable<string>,
  policy: DistributionPolicy,
): DistributionIssue[] {
  if (!policy.includeRoots.includes('src')) return [];

  const expected = new Set(PUBLIC_PAGE_ROUTE_PATHS);
  const selected = new Set(
    [...paths].filter((filePath) => (
      /^src\/app(?:\/.*)?\/page\.(?:js|jsx|ts|tsx)$/.test(filePath)
    )),
  );
  const issues: DistributionIssue[] = [];
  for (const filePath of selected) {
    if (!expected.has(filePath)) {
      issues.push(issue(
        'non-foss-source-text',
        filePath,
        'public page is outside the exact reviewed Step 1 allowlist',
      ));
    }
  }
  for (const filePath of expected) {
    if (!selected.has(filePath)) {
      issues.push(issue(
        'explicit-path-missing',
        filePath,
        'required public page is absent from the exact Step 1 allowlist surface',
      ));
    }
  }
  return issues;
}

function publicAppHandlerRouteSurfaceIssues(
  paths: Iterable<string>,
  policy: DistributionPolicy,
): DistributionIssue[] {
  if (!policy.includeRoots.includes('src')) return [];

  const expected = new Set(PUBLIC_APP_HANDLER_ROUTE_PATHS);
  const selected = new Set(
    [...paths].filter((filePath) => (
      !filePath.startsWith('src/app/api/')
      && /^src\/app\/.+\/route\.(?:js|jsx|ts|tsx)$/.test(filePath)
    )),
  );
  const issues: DistributionIssue[] = [];
  for (const filePath of selected) {
    if (!expected.has(filePath)) {
      issues.push(issue(
        'non-foss-source-text',
        filePath,
        'public route handler is outside the exact reviewed Step 1 allowlist',
      ));
    }
  }
  for (const filePath of expected) {
    if (!selected.has(filePath)) {
      issues.push(issue(
        'explicit-path-missing',
        filePath,
        'required public route handler is absent from the exact Step 1 allowlist surface',
      ));
    }
  }
  return issues;
}

function publicAppShellSurfaceIssues(
  paths: Iterable<string>,
  policy: DistributionPolicy,
): DistributionIssue[] {
  if (!policy.includeRoots.includes('src')) return [];

  const expected = new Set(PUBLIC_APP_SHELL_PATHS);
  const selected = new Set(
    [...paths].filter((filePath) => (
      /^src\/app(?:\/.*)?\/(?:default|error|global-error|layout|loading|not-found|template)\.(?:js|jsx|ts|tsx)$/
        .test(filePath)
    )),
  );
  const issues: DistributionIssue[] = [];
  for (const filePath of selected) {
    if (!expected.has(filePath)) {
      issues.push(issue(
        'non-foss-source-text',
        filePath,
        'public App Router shell file is outside the exact reviewed Step 1 allowlist',
      ));
    }
  }
  for (const filePath of expected) {
    if (!selected.has(filePath)) {
      issues.push(issue(
        'explicit-path-missing',
        filePath,
        'required public App Router shell file is absent from the reviewed surface',
      ));
    }
  }
  return issues;
}

function publicMetadataRouteSurfaceIssues(
  paths: Iterable<string>,
  policy: DistributionPolicy,
): DistributionIssue[] {
  if (!policy.includeRoots.includes('src')) return [];

  const expected = new Set(PUBLIC_METADATA_ROUTE_PATHS);
  const selected = new Set(
    [...paths].filter((filePath) => (
      /^src\/app(?:\/.*)?\/(?:apple-icon|icon|manifest|opengraph-image|robots|sitemap|twitter-image)\.(?:js|jsx|ts|tsx)$/
        .test(filePath)
    )),
  );
  const issues: DistributionIssue[] = [];
  for (const filePath of selected) {
    if (!expected.has(filePath)) {
      issues.push(issue(
        'non-foss-source-text',
        filePath,
        'public metadata route is outside the exact reviewed Step 1 allowlist',
      ));
    }
  }
  for (const filePath of expected) {
    if (!selected.has(filePath)) {
      issues.push(issue(
        'explicit-path-missing',
        filePath,
        'required public metadata route is absent from the reviewed surface',
      ));
    }
  }
  return issues;
}

function inspectGeneratedFiles(
  candidates: Set<string>,
  policy: DistributionPolicy,
): { files: ExportFileRecord[]; issues: DistributionIssue[] } {
  const files: ExportFileRecord[] = [];
  const issues: DistributionIssue[] = [];
  const generatedFiles = [...policy.generatedTextFiles].sort((left, right) =>
    left.path.localeCompare(right.path));
  const generatedPaths = new Set(generatedFiles.map((file) => file.path));
  const protectedPaths = new Set(PROTECTED_PUBLIC_FALLBACKS.map((file) => file.path));
  const enforceProtectedReplacementSet = PROTECTED_PUBLIC_FALLBACKS.some((expected) => (
    generatedPaths.has(expected.path)
    || policy.includeRoots.some((root) => matchesPrefix(expected.path, root))
  ));
  if (enforceProtectedReplacementSet) {
    for (const generated of generatedFiles) {
      if (isExcluded(generated.path, policy) && !protectedPaths.has(generated.path)) {
        issues.push(issue(
          'non-foss-source-text',
          generated.path,
          'generated replacement for excluded source is not pinned by reviewed licence/hash',
        ));
      }
    }
  }
  const occupiedPaths = [...candidates, 'FOSS-DISTRIBUTION-MANIFEST.json'];
  for (const generated of generatedFiles) {
    const collision = occupiedPaths.find((occupied) => pathsCollidePortably(generated.path, occupied));
    if (collision) {
      issues.push(issue(
        'generated-path-collision',
        generated.path,
        `generated fallback collides with selected or reserved path: ${collision}`,
      ));
    }
    const generatedCollision = generatedFiles.find((other) =>
      other !== generated && pathsCollidePortably(generated.path, other.path));
    if (generatedCollision) {
      issues.push(issue(
        'generated-path-collision',
        generated.path,
        `generated fallback collides with generated path: ${generatedCollision.path}`,
      ));
    }
    const buffer = Buffer.from(generated.text, 'utf8');
    if (buffer.byteLength > policy.maximumFileBytes) {
      issues.push(issue(
        'file-too-large',
        generated.path,
        `generated file is ${buffer.byteLength} bytes; limit is ${policy.maximumFileBytes}`,
      ));
    }
    const extension = path.posix.extname(generated.path).toLowerCase();
    if (!policy.allowedTextExtensions.includes(extension) || buffer.includes(0)) {
      issues.push(issue(
        'unsupported-file-type',
        generated.path,
        'generated fallback is not an explicitly allowed text type',
      ));
    }
    const finding = credentialFinding(generated.text);
    if (finding) {
      issues.push(issue(
        'credential-shaped-text',
        generated.path,
        `generated fallback matched ${finding}; content is intentionally omitted from reports`,
      ));
    }
    const learnerIdentifier = learnerIdentifierFinding(generated.text);
    if (learnerIdentifier) {
      issues.push(issue(
        'learner-identifier',
        generated.path,
        `generated fallback matched ${learnerIdentifier}; content is intentionally omitted from reports`,
      ));
    }
    files.push({
      path: generated.path,
      bytes: buffer.byteLength,
      sha256: sha256(buffer),
      mode: '0644',
      licence: generated.licence,
    });
  }
  for (const expected of PROTECTED_PUBLIC_FALLBACKS) {
    if (
      !generatedPaths.has(expected.path)
      && !policy.includeRoots.some((root) => matchesPrefix(expected.path, root))
    ) continue;
    if (candidates.has(expected.path)) {
      issues.push(issue(
        'non-foss-source-text',
        expected.path,
        'protected public fallback must not copy deployment-specific or private source bytes',
      ));
    }
    const generated = files.find((file) => file.path === expected.path);
    if (
      !generated
      || generated.licence !== expected.licence
      || generated.sha256 !== expected.sha256
    ) {
      issues.push(issue(
        'non-foss-source-text',
        expected.path,
        'protected generated fallback is missing or differs from its reviewed licence/hash',
      ));
    }
  }
  return { files, issues };
}

function existingExportManifestIssues(
  repoRoot: string,
  policy: DistributionPolicy,
  expectedFiles: ExportFileRecord[],
): DistributionIssue[] {
  const manifestPath = path.join(repoRoot, EXPORT_MANIFEST_PATH);
  if (!fs.existsSync(manifestPath)) return [];

  const issues: DistributionIssue[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  } catch {
    return [issue(
      'export-manifest-mismatch',
      EXPORT_MANIFEST_PATH,
      'artifact manifest is not valid JSON',
    )];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.files)) {
    return [issue(
      'export-manifest-mismatch',
      EXPORT_MANIFEST_PATH,
      'artifact manifest has an invalid structure',
    )];
  }

  const actualArtifactFiles: string[] = [];
  const walkArtifact = (relativeDirectory: string): void => {
    const absoluteDirectory = path.join(repoRoot, relativeDirectory);
    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true }).sort((a, b) => (
      a.name.localeCompare(b.name)
    ))) {
      const relative = relativeDirectory
        ? path.posix.join(relativeDirectory, entry.name)
        : entry.name;
      const absolute = path.join(repoRoot, relative);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        issues.push(issue(
          'export-manifest-mismatch',
          relative,
          'artifact contains an unmanifested symlink or special file',
        ));
      } else if (stat.isDirectory()) {
        walkArtifact(relative);
      } else if (relative !== EXPORT_MANIFEST_PATH) {
        actualArtifactFiles.push(relative);
      }
    }
  };
  walkArtifact('');

  const sortedExpected = [...expectedFiles].sort((left, right) =>
    left.path.localeCompare(right.path));
  const expectedPaths = sortedExpected.map((file) => file.path);
  const sortedActualPaths = actualArtifactFiles.sort();
  if (JSON.stringify(sortedActualPaths) !== JSON.stringify(expectedPaths)) {
    const expectedSet = new Set(expectedPaths);
    const actualSet = new Set(sortedActualPaths);
    for (const extraPath of sortedActualPaths.filter((filePath) => !expectedSet.has(filePath))) {
      issues.push(issue(
        'export-manifest-mismatch',
        extraPath,
        'artifact contains a file that is absent from the export manifest',
      ));
    }
    for (const missingPath of expectedPaths.filter((filePath) => !actualSet.has(filePath))) {
      issues.push(issue(
        'export-manifest-mismatch',
        missingPath,
        'export manifest records a file that is absent from the artifact',
      ));
    }
  }
  const expectedTotalBytes = sortedExpected.reduce((sum, file) => sum + file.bytes, 0);
  const expectedPolicyHash = sha256(fs.readFileSync(path.join(repoRoot, POLICY_PATH)));
  const expectedReviewedHash = sha256(fs.readFileSync(path.join(repoRoot, policy.pathManifest)));
  if (
    parsed.schemaVersion !== 1
    || parsed.boundaryPolicy !== POLICY_PATH
    || parsed.boundaryPolicySha256 !== expectedPolicyHash
    || parsed.reviewedPathsSha256 !== expectedReviewedHash
    || parsed.fileCount !== sortedExpected.length
    || parsed.totalBytes !== expectedTotalBytes
    || JSON.stringify(parsed.files) !== JSON.stringify(sortedExpected)
  ) {
    issues.push(issue(
      'export-manifest-mismatch',
      EXPORT_MANIFEST_PATH,
      'artifact manifest metadata or reviewed file records differ from the current boundary',
    ));
  }

  for (const expected of sortedExpected) {
    const absolute = path.join(repoRoot, expected.path);
    if (!fs.existsSync(absolute)) {
      issues.push(issue(
        'export-manifest-mismatch',
        expected.path,
        'artifact file recorded by the manifest is missing',
      ));
      continue;
    }
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      issues.push(issue(
        'export-manifest-mismatch',
        expected.path,
        'artifact file recorded by the manifest is not a regular non-symlink file',
      ));
      continue;
    }
    const buffer = fs.readFileSync(absolute);
    const mode = stat.mode & 0o111 ? '0755' : '0644';
    if (
      buffer.byteLength !== expected.bytes
      || sha256(buffer) !== expected.sha256
      || mode !== expected.mode
    ) {
      issues.push(issue(
        'export-manifest-mismatch',
        expected.path,
        'artifact bytes or mode differ from the recorded export manifest',
      ));
    }
  }
  return issues;
}

export function auditDistributionBoundary(
  repoRoot: string,
  policy = loadDistributionPolicy(repoRoot),
  options: DistributionAuditOptions = {},
): DistributionAuditReport {
  const discovery = discoverCandidatePaths(repoRoot, policy);
  const reviewed = parseReviewedPathManifest(repoRoot, policy);
  const issues = [...discovery.issues, ...reviewed.issues];
  const candidates = new Set(discovery.paths);
  issues.push(...binaryPolicyIssues(candidates, policy));
  const generated = inspectGeneratedFiles(candidates, policy);
  issues.push(...generated.issues);
  issues.push(...publicApiRouteSurfaceIssues([
    ...candidates,
    ...policy.generatedTextFiles.map((entry) => entry.path),
  ], policy));
  issues.push(...publicPageRouteSurfaceIssues([
    ...candidates,
    ...policy.generatedTextFiles.map((entry) => entry.path),
  ], policy));
  issues.push(...publicAppHandlerRouteSurfaceIssues([
    ...candidates,
    ...policy.generatedTextFiles.map((entry) => entry.path),
  ], policy));
  issues.push(...publicAppShellSurfaceIssues([
    ...candidates,
    ...policy.generatedTextFiles.map((entry) => entry.path),
  ], policy));
  issues.push(...publicMetadataRouteSurfaceIssues([
    ...candidates,
    ...policy.generatedTextFiles.map((entry) => entry.path),
  ], policy));
  const reviewedPaths = new Set(reviewed.paths);
  let totalBytes = 0;
  const licenseCounts: Partial<Record<DistributionLicence, number>> = {};
  const inspectedFiles: ExportFileRecord[] = [];
  const inspectedContent = new Map<string, InspectedFile>();

  for (const filePath of discovery.paths) {
    const result = inspectFile(repoRoot, filePath, policy);
    issues.push(...result.issues);
    if (result.inspected) {
      inspectedContent.set(filePath, result.inspected);
      totalBytes += result.inspected.bytes;
      const licence = result.inspected.licence;
      licenseCounts[licence] = (licenseCounts[licence] ?? 0) + 1;
      inspectedFiles.push({
        path: filePath,
        bytes: result.inspected.bytes,
        sha256: result.inspected.sha256,
        mode: result.inspected.mode,
        licence,
      });
    }
    if (!reviewedPaths.has(filePath)) {
      issues.push(issue('unreviewed-candidate', filePath, 'candidate is absent from the reviewed path manifest'));
    }
  }
  for (const filePath of reviewed.paths) {
    if (isForbidden(filePath, policy)) {
      issues.push(issue('forbidden-reviewed-path', filePath, 'reviewed path is under a forbidden root'));
    }
    if (!candidates.has(filePath)) {
      issues.push(issue('reviewed-path-missing', filePath, 'reviewed path is not a current candidate'));
    }
  }
  issues.push(...openContentCrossReferenceIssues(inspectedContent));
  issues.push(...publicDistributionMetadataIssues(inspectedContent, policy));
  for (const generatedFile of generated.files) {
    totalBytes += generatedFile.bytes;
    licenseCounts[generatedFile.licence] = (licenseCounts[generatedFile.licence] ?? 0) + 1;
  }
  if (options.verifyExistingExportManifest !== false) {
    issues.push(...existingExportManifestIssues(
      repoRoot,
      policy,
      [...inspectedFiles, ...generated.files],
    ));
  }

  const finalIssues = sortedIssues(issues);
  return {
    schemaVersion: 1,
    ok: finalIssues.length === 0,
    policyPath: POLICY_PATH,
    pathManifest: policy.pathManifest,
    fileCount: discovery.paths.length + generated.files.length,
    totalBytes,
    licenseCounts,
    issues: finalIssues,
  };
}

function candidateSafetyIssues(
  repoRoot: string,
  policy: DistributionPolicy,
  discovery: CandidateDiscovery,
): DistributionIssue[] {
  const issues = [...discovery.issues];
  const candidates = new Set(discovery.paths);
  issues.push(...binaryPolicyIssues(candidates, policy));
  issues.push(...inspectGeneratedFiles(candidates, policy).issues);
  issues.push(...publicApiRouteSurfaceIssues([
    ...candidates,
    ...policy.generatedTextFiles.map((entry) => entry.path),
  ], policy));
  issues.push(...publicPageRouteSurfaceIssues([
    ...candidates,
    ...policy.generatedTextFiles.map((entry) => entry.path),
  ], policy));
  issues.push(...publicAppHandlerRouteSurfaceIssues([
    ...candidates,
    ...policy.generatedTextFiles.map((entry) => entry.path),
  ], policy));
  issues.push(...publicAppShellSurfaceIssues([
    ...candidates,
    ...policy.generatedTextFiles.map((entry) => entry.path),
  ], policy));
  issues.push(...publicMetadataRouteSurfaceIssues([
    ...candidates,
    ...policy.generatedTextFiles.map((entry) => entry.path),
  ], policy));
  const inspectedContent = new Map<string, InspectedFile>();
  for (const filePath of discovery.paths) {
    const result = inspectFile(repoRoot, filePath, policy);
    issues.push(...result.issues);
    if (result.inspected) inspectedContent.set(filePath, result.inspected);
  }
  issues.push(...openContentCrossReferenceIssues(inspectedContent));
  issues.push(...publicDistributionMetadataIssues(inspectedContent, policy));
  return sortedIssues(issues);
}

export function writeReviewedPathManifest(
  repoRoot: string,
  policy = loadDistributionPolicy(repoRoot),
): DistributionAuditReport {
  const discovery = discoverCandidatePaths(repoRoot, policy);
  const safetyIssues = candidateSafetyIssues(repoRoot, policy, discovery);
  if (safetyIssues.length > 0) {
    throw new Error(
      `refusing to write reviewed paths; ${safetyIssues.length} safety issue(s): `
      + safetyIssues.map((entry) => `${entry.code}:${entry.path}`).join(', '),
    );
  }
  const destination = path.join(repoRoot, policy.pathManifest);
  const destinationParent = path.dirname(destination);
  const expectedParent = path.resolve(fs.realpathSync(repoRoot), path.dirname(policy.pathManifest));
  if (fs.realpathSync(destinationParent) !== expectedParent) {
    throw new Error('refusing to write reviewed paths through an intermediate symlink');
  }
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) {
    throw new Error('refusing to replace a symlinked reviewed path manifest');
  }
  const temporary = path.join(
    destinationParent,
    `.${path.basename(destination)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  );
  try {
    fs.writeFileSync(
      temporary,
      discovery.paths.length > 0 ? `${discovery.paths.join('\n')}\n` : '',
      { flag: 'wx', mode: 0o644 },
    );
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
  const report = auditDistributionBoundary(repoRoot, policy, {
    // Path-lock refresh is a source-tree action. In an installed public checkout
    // its embedded export manifest is necessarily stale until a fresh export is
    // produced, so it must not make an otherwise valid lock write fail after
    // the destination has already been replaced.
    verifyExistingExportManifest: false,
  });
  if (!report.ok) throw new Error('reviewed path manifest did not pass after writing');
  return report;
}

function prepareExportSnapshot(
  repoRoot: string,
  expectedPolicy: DistributionPolicy,
): ExportSnapshot {
  const policy = loadDistributionPolicy(repoRoot);
  if (!isDeepStrictEqual(policy, expectedPolicy)) {
    throw new Error('distribution policy changed after the initial audit');
  }

  const discovery = discoverCandidatePaths(repoRoot, policy);
  const reviewed = parseReviewedPathManifest(repoRoot, policy);
  const candidates = new Set(discovery.paths);
  const reviewedPaths = new Set(reviewed.paths);
  const generated = inspectGeneratedFiles(candidates, policy);
  const issues = [
    ...discovery.issues,
    ...reviewed.issues,
    ...binaryPolicyIssues(candidates, policy),
    ...generated.issues,
    ...publicApiRouteSurfaceIssues([
      ...candidates,
      ...policy.generatedTextFiles.map((entry) => entry.path),
    ], policy),
    ...publicPageRouteSurfaceIssues([
      ...candidates,
      ...policy.generatedTextFiles.map((entry) => entry.path),
    ], policy),
    ...publicAppHandlerRouteSurfaceIssues([
      ...candidates,
      ...policy.generatedTextFiles.map((entry) => entry.path),
    ], policy),
    ...publicAppShellSurfaceIssues([
      ...candidates,
      ...policy.generatedTextFiles.map((entry) => entry.path),
    ], policy),
    ...publicMetadataRouteSurfaceIssues([
      ...candidates,
      ...policy.generatedTextFiles.map((entry) => entry.path),
    ], policy),
  ];
  const copiedFiles: SnapshottedExportFile[] = [];
  const inspectedContent = new Map<string, InspectedFile>();

  for (const filePath of discovery.paths) {
    const result = inspectFile(repoRoot, filePath, policy);
    issues.push(...result.issues);
    if (!reviewedPaths.has(filePath)) {
      issues.push(issue(
        'unreviewed-candidate',
        filePath,
        'candidate is absent from the reviewed path manifest',
      ));
    }
    if (result.inspected) {
      inspectedContent.set(filePath, result.inspected);
      copiedFiles.push({
        path: filePath,
        bytes: result.inspected.bytes,
        sha256: result.inspected.sha256,
        mode: result.inspected.mode,
        licence: result.inspected.licence,
        buffer: result.inspected.buffer,
      });
    }
  }
  issues.push(...openContentCrossReferenceIssues(inspectedContent));
  issues.push(...publicDistributionMetadataIssues(inspectedContent, policy));
  for (const filePath of reviewed.paths) {
    if (isForbidden(filePath, policy)) {
      issues.push(issue(
        'forbidden-reviewed-path',
        filePath,
        'reviewed path is under a forbidden root',
      ));
    }
    if (!candidates.has(filePath)) {
      issues.push(issue(
        'reviewed-path-missing',
        filePath,
        'reviewed path is not a current candidate',
      ));
    }
  }
  if (issues.length > 0) {
    const finalIssues = sortedIssues(issues);
    throw new Error(
      `refusing inconsistent export snapshot; ${finalIssues.length} issue(s): `
      + finalIssues.map((entry) => `${entry.code}:${entry.path}`).join(', '),
    );
  }

  const policyFile = copiedFiles.find((file) => file.path === POLICY_PATH);
  const reviewedFile = copiedFiles.find((file) => file.path === policy.pathManifest);
  if (!policyFile || !reviewedFile) {
    throw new Error('distribution policy and reviewed path manifest must be copied into the artifact');
  }
  let capturedPolicy: DistributionPolicy;
  try {
    capturedPolicy = parseDistributionPolicy(JSON.parse(policyFile.buffer.toString('utf8')) as unknown);
  } catch {
    throw new Error('captured distribution policy is invalid');
  }
  if (!isDeepStrictEqual(capturedPolicy, policy)) {
    throw new Error('distribution policy changed while the export snapshot was being read');
  }
  const capturedReviewed = parseReviewedPathManifestText(
    reviewedFile.buffer.toString('utf8'),
    policy,
  );
  if (
    capturedReviewed.issues.length > 0
    || !isDeepStrictEqual(capturedReviewed.paths, discovery.paths)
  ) {
    throw new Error('reviewed path manifest changed while the export snapshot was being read');
  }

  const generatedFiles: SnapshottedExportFile[] = generated.files.map((record) => {
    const definition = policy.generatedTextFiles.find((entry) => entry.path === record.path);
    if (!definition) throw new Error(`missing generated file definition: ${record.path}`);
    return { ...record, buffer: Buffer.from(definition.text, 'utf8') };
  });
  const files = [...copiedFiles, ...generatedFiles].sort((left, right) => (
    left.path.localeCompare(right.path)
  ));
  return {
    files,
    policySha256: sha256(policyFile.buffer),
    reviewedPathsSha256: sha256(reviewedFile.buffer),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normaliseDirectories(root: string): void {
  const directories: string[] = [];
  const walk = (directory: string): void => {
    directories.push(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(directory, entry.name));
    }
  };
  walk(root);
  for (const directory of directories.reverse()) {
    fs.chmodSync(directory, 0o755);
    fs.utimesSync(directory, NORMALIZED_MTIME, NORMALIZED_MTIME);
  }
}

export function exportDistribution(
  repoRoot: string,
  policy: DistributionPolicy,
  outputPath: string,
  hooks: DistributionExportHooks = {},
): ExportManifest {
  const report = auditDistributionBoundary(repoRoot, policy, {
    // An export artifact may itself become the source of a later public
    // contribution. Its embedded receipt describes the older published
    // snapshot, so validate the current source boundary here and mint a new
    // receipt below. The temporary output's self-audit remains strict.
    verifyExistingExportManifest: false,
  });
  if (!report.ok) {
    throw new Error(`FOSS boundary audit failed with ${report.issues.length} issue(s)`);
  }
  const absoluteRepo = fs.realpathSync(repoRoot);
  const requestedOutput = path.resolve(outputPath);
  if (fs.existsSync(requestedOutput)) {
    throw new Error(`export destination already exists: ${requestedOutput}`);
  }
  const requestedParent = path.dirname(requestedOutput);
  if (!fs.existsSync(requestedParent) || !fs.statSync(requestedParent).isDirectory()) {
    throw new Error(`export destination parent does not exist: ${requestedParent}`);
  }
  const realParent = fs.realpathSync(requestedParent);
  const absoluteOutput = path.join(realParent, path.basename(requestedOutput));
  if (isInside(absoluteRepo, absoluteOutput)) {
    throw new Error('export destination must be outside the source repository');
  }
  if (fs.existsSync(absoluteOutput)) {
    throw new Error(`export destination already exists: ${absoluteOutput}`);
  }
  const parent = realParent;
  hooks.afterInitialAudit?.();
  const snapshot = prepareExportSnapshot(repoRoot, policy);
  const temporary = path.join(
    parent,
    `.${path.basename(absoluteOutput)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  );
  fs.mkdirSync(temporary, { mode: 0o755 });
  try {
    const files: ExportFileRecord[] = [];
    for (const file of snapshot.files) {
      const destination = path.join(temporary, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
      fs.writeFileSync(destination, file.buffer, {
        mode: file.mode === '0755' ? 0o755 : 0o644,
      });
      fs.utimesSync(destination, NORMALIZED_MTIME, NORMALIZED_MTIME);
      files.push({
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
        mode: file.mode,
        licence: file.licence,
      });
    }

    const exportManifest: ExportManifest = {
      schemaVersion: 1,
      boundaryPolicy: POLICY_PATH,
      boundaryPolicySha256: snapshot.policySha256,
      reviewedPathsSha256: snapshot.reviewedPathsSha256,
      fileCount: files.length,
      totalBytes: snapshot.totalBytes,
      files,
    };
    const manifestPath = path.join(temporary, EXPORT_MANIFEST_PATH);
    fs.writeFileSync(manifestPath, `${JSON.stringify(exportManifest, null, 2)}\n`, { mode: 0o644 });
    fs.utimesSync(manifestPath, NORMALIZED_MTIME, NORMALIZED_MTIME);
    normaliseDirectories(temporary);
    const selfAudit = auditDistributionBoundary(temporary);
    if (!selfAudit.ok) {
      throw new Error(
        `generated export failed self-audit with ${selfAudit.issues.length} issue(s): `
        + selfAudit.issues.map((entry) => `${entry.code}:${entry.path}`).join(', '),
      );
    }
    fs.renameSync(temporary, absoluteOutput);
    return exportManifest;
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

interface CliArgs {
  action: 'audit' | 'export' | 'write-paths';
  exportPath: string | null;
  json: boolean;
  sourceTree: boolean;
}

export function parseDistributionArgs(argv: string[]): CliArgs {
  let action: CliArgs['action'] = 'audit';
  let exportPath: string | null = null;
  let json = false;
  let sourceTree = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') json = true;
    else if (arg === '--source-tree') sourceTree = true;
    else if (arg === '--write-paths') {
      if (action !== 'audit') throw new Error('choose only one boundary action');
      action = 'write-paths';
    } else if (arg === '--export') {
      if (action !== 'audit') throw new Error('choose only one boundary action');
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--export requires a destination');
      action = 'export';
      exportPath = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (sourceTree && action !== 'audit') {
    throw new Error('--source-tree is valid only for an audit');
  }
  return { action, exportPath, json, sourceTree };
}

function printReport(report: DistributionAuditReport): void {
  const status = report.ok ? 'PASS' : 'FAIL';
  const licences = Object.entries(report.licenseCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([licence, count]) => `${licence} ${count}`)
    .join(', ');
  console.log(
    `FOSS distribution boundary ${status}: ${report.fileCount} file(s), `
    + `${report.totalBytes} byte(s)${licences ? `; ${licences}` : ''}`,
  );
  for (const entry of report.issues) {
    console.error(`- ${entry.code}: ${entry.path} (${entry.detail})`);
  }
}

async function main(): Promise<void> {
  const args = parseDistributionArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const policy = loadDistributionPolicy(repoRoot);
  if (args.action === 'write-paths') {
    const report = writeReviewedPathManifest(repoRoot, policy);
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
    return;
  }
  if (args.action === 'export') {
    const manifest = exportDistribution(repoRoot, policy, args.exportPath!);
    console.log(
      `FOSS distribution export PASS: ${manifest.fileCount} file(s), `
      + `${manifest.totalBytes} byte(s) -> ${path.resolve(args.exportPath!)}`,
    );
    return;
  }
  const report = auditDistributionBoundary(repoRoot, policy, {
    verifyExistingExportManifest: !args.sourceTree,
  });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  if (!report.ok) process.exitCode = 1;
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
