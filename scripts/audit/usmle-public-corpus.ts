#!/usr/bin/env node
/**
 * Public-USMLE corpus audit. It is read-only unless the explicit,
 * release-gated `--write-release-fingerprints` maintenance flag is supplied.
 *
 * The default root is the repo-native release corpus. Use the private package
 * script (or explicit flags) to inspect only cross-listed private candidates.
 * This command never imports Prisma or mutates question/citation source.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadQuestionBankFromDisk } from '../../src/lib/question-bank/load';
import { loadExcludedQuestionIdsFromDisk } from '../../src/lib/question-bank/exclusions-disk';
import {
  openUsmleSourceReceiptFailures,
  parseOpenUsmleSourceRegistry,
} from '../../src/lib/usmle/open-source-registry';
import {
  parseOpenUsmleBaselineManifest,
  validateOpenUsmleBaselineReferences,
} from '../../src/lib/usmle/public-baseline';
import {
  parseOpenUsmleReleaseManifest,
  validateOpenUsmleReleaseFingerprints,
  validateOpenUsmleReleaseMembership,
} from '../../src/lib/usmle/public-release';
import { buildPublicUsmleReleaseFingerprints } from '../../src/lib/usmle/public-serving-drift';
import {
  buildPublicUsmleSourceAudit,
  publicUsmleReleaseGateFailures,
} from '../../src/lib/usmle/public-corpus-audit';
import { checkItem } from '../usmle/item-rubric';

const DEFAULT_BANK_DIR = 'open-content/usmle/step1/questions';
const DEFAULT_SOURCES = path.join(path.dirname(DEFAULT_BANK_DIR), 'sources.json');
const DEFAULT_BASELINE = path.join(path.dirname(DEFAULT_BANK_DIR), 'baseline-v1.json');
const DEFAULT_RELEASE = path.join(path.dirname(DEFAULT_BANK_DIR), 'release-v1.json');
const DEFAULT_OUT = '/tmp/md3-usmle-corpus-audit.json';

interface Args {
  bankDir: string;
  sources: string | null;
  baseline: string | null;
  validateBaseline: boolean;
  out: string | null;
  json: boolean;
  membersOnly: boolean;
  registeredRootDirs: boolean;
  releaseGate: boolean;
  writeReleaseFingerprints: boolean;
  minEligible: number;
}

export interface PublicUsmleAuditRunResult {
  report: ReturnType<typeof buildPublicUsmleSourceAudit>;
  releaseFailures: string[];
  releaseFingerprintWrite: { path: string; count: number } | null;
}

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function valueWithin(arg: string, prefix: string): string {
  const value = arg.slice(prefix.length);
  if (!value) throw new Error(`${prefix.slice(0, -1)} requires a value`);
  return value;
}

export function parsePublicUsmleAuditArgs(argv: string[]): Args {
  const args: Args = {
    bankDir: DEFAULT_BANK_DIR,
    sources: null,
    baseline: null,
    validateBaseline: true,
    out: null,
    json: false,
    membersOnly: false,
    registeredRootDirs: false,
    releaseGate: false,
    writeReleaseFingerprints: false,
    minEligible: 1,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--bank-dir') args.bankDir = valueAfter(argv, index++, arg);
    else if (arg.startsWith('--bank-dir=')) args.bankDir = valueWithin(arg, '--bank-dir=');
    else if (arg === '--sources') args.sources = valueAfter(argv, index++, arg);
    else if (arg.startsWith('--sources=')) args.sources = valueWithin(arg, '--sources=');
    else if (arg === '--baseline') args.baseline = valueAfter(argv, index++, arg);
    else if (arg.startsWith('--baseline=')) args.baseline = valueWithin(arg, '--baseline=');
    else if (arg === '--no-baseline') args.validateBaseline = false;
    else if (arg === '--out') args.out = valueAfter(argv, index++, arg);
    else if (arg.startsWith('--out=')) args.out = valueWithin(arg, '--out=');
    else if (arg === '--json') args.json = true;
    else if (arg === '--members-only') args.membersOnly = true;
    else if (arg === '--registered-root-dirs') args.registeredRootDirs = true;
    else if (arg === '--release-gate') args.releaseGate = true;
    else if (arg === '--write-release-fingerprints') args.writeReleaseFingerprints = true;
    else if (arg === '--min-eligible') {
      args.minEligible = Number(valueAfter(argv, index++, arg));
    } else if (arg.startsWith('--min-eligible=')) {
      args.minEligible = Number(valueWithin(arg, '--min-eligible='));
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }

  if (!Number.isInteger(args.minEligible) || args.minEligible < 0) {
    throw new Error('--min-eligible must be a non-negative integer');
  }
  if (args.bankDir !== DEFAULT_BANK_DIR && !args.sources) {
    throw new Error('--sources is required with a nonstandard --bank-dir');
  }
  if (!args.validateBaseline && args.baseline) {
    throw new Error('--baseline and --no-baseline are mutually exclusive');
  }
  if (args.bankDir !== DEFAULT_BANK_DIR && args.validateBaseline && !args.baseline) {
    throw new Error('--baseline is required with a nonstandard --bank-dir');
  }
  if (args.releaseGate && !args.validateBaseline) {
    throw new Error('--no-baseline cannot be used with --release-gate');
  }
  if (args.writeReleaseFingerprints && !args.releaseGate) {
    throw new Error('--write-release-fingerprints requires --release-gate');
  }
  return args;
}

function writeReport(outPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceJsonAtomically(targetPath: string, value: unknown): void {
  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let tempCreated = false;
  try {
    const descriptor = fs.openSync(tempPath, 'wx', 0o644);
    tempCreated = true;
    try {
      fs.fchmodSync(descriptor, 0o644);
      fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(tempPath, targetPath);
    tempCreated = false;
  } finally {
    if (tempCreated) fs.rmSync(tempPath, { force: true });
  }
}

function printHumanSummary(report: ReturnType<typeof buildPublicUsmleSourceAudit>): void {
  const summary = report.summary;
  console.log(
    `USMLE corpus audit (${report.basis}): ${summary.eligibleCount}/${summary.auditedQuestionCount} eligible; `
    + `${summary.blockerCount} blocker(s); ${summary.skippedNonMemberCount} non-member(s) skipped`,
  );
  for (const [lane, count] of Object.entries(report.countsByLane)) {
    console.log(`  ${lane}: ${count}`);
  }
  for (const [reason, count] of Object.entries(report.countsByReason)) {
    console.log(`    ${reason}: ${count}`);
  }
  if (report.baseline) {
    console.log(
      `  baseline: ${report.baseline.eligibleQuestionCount}/`
      + `${report.baseline.manifestQuestionCount} eligible; `
      + `${report.baseline.blockerCount} blocker(s)`,
    );
  }
  console.log(
    `  source receipt: ${report.sourceRegistry.sourceCount} source(s), `
    + `${report.sourceRegistry.passageCount} passage(s), verified ${report.sourceRegistry.verifiedAt}, `
    + `registry digest ${report.sourceRegistry.registrySha256}, `
    + `quote digest ${report.sourceRegistry.quoteSetSha256}`,
  );
  console.log(
    `  raw answer key: ${report.rawAnswerKey.representedLabelCount}/5 labels; `
    + `max share ${(report.rawAnswerKey.maximumLabelShare * 100).toFixed(1)}%; `
    + `longest same-label streak ${report.rawAnswerKey.longestSameLabelStreak}`,
  );
}

/**
 * Run the disk-only audit without mutating global process state. Scoped seed
 * and release commands call this directly so they cannot accidentally bypass
 * the same mechanical eligibility gate used by CI.
 */
export function runPublicUsmleAudit(
  argv: string[],
  options: { silent?: boolean } = {},
): PublicUsmleAuditRunResult {
  const args = parsePublicUsmleAuditArgs(argv);
  const bankDir = path.resolve(process.cwd(), args.bankDir);
  const sourcesPath = path.resolve(process.cwd(), args.sources ?? DEFAULT_SOURCES);
  let sourceRegistryInput: unknown;
  try {
    sourceRegistryInput = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `${sourcesPath}: unable to read source registry (${error instanceof Error ? error.message : 'unknown error'})`,
    );
  }
  let sourceRegistry: ReturnType<typeof parseOpenUsmleSourceRegistry>;
  try {
    sourceRegistry = parseOpenUsmleSourceRegistry(sourceRegistryInput);
  } catch (error) {
    throw new Error(
      `${sourcesPath}: invalid source registry (${error instanceof Error ? error.message : 'unknown error'})`,
    );
  }
  const loaded = loadQuestionBankFromDisk({
    bankDir,
    allowUnregisteredRootDirs: !args.registeredRootDirs,
  });
  const exclusions = loadExcludedQuestionIdsFromDisk({
    dir: path.join(bankDir, '_exclusions'),
    strict: true,
  });
  const inputErrors = [...loaded.errors, ...exclusions.errors];
  if (inputErrors.length > 0) {
    throw new Error(
      `USMLE corpus input validation failed (${inputErrors.length} issue(s)):\n`
      + inputErrors.map((error) => `- ${error}`).join('\n'),
    );
  }

  let baselineQuestionIds: Set<string> | null = null;
  let releaseRefresh: {
    path: string;
    manifest: ReturnType<typeof parseOpenUsmleReleaseManifest>;
    fingerprints: Record<string, string>;
  } | null = null;
  if (args.validateBaseline) {
    const baselinePath = path.resolve(process.cwd(), args.baseline ?? DEFAULT_BASELINE);
    let baselineInput: unknown;
    try {
      baselineInput = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    } catch (error) {
      throw new Error(
        `${baselinePath}: unable to read baseline manifest (${error instanceof Error ? error.message : 'unknown error'})`,
      );
    }
    let baselineManifest: ReturnType<typeof parseOpenUsmleBaselineManifest>;
    try {
      baselineManifest = parseOpenUsmleBaselineManifest(baselineInput);
    } catch (error) {
      throw new Error(
        `${baselinePath}: invalid baseline manifest (${error instanceof Error ? error.message : 'unknown error'})`,
      );
    }
    const baselineErrors = validateOpenUsmleBaselineReferences(
      baselineManifest,
      new Set(loaded.questions.map((question) => question.id)),
    );
    if (baselineErrors.length > 0) {
      throw new Error(
        `${baselinePath}: baseline validation failed (${baselineErrors.length} issue(s)):\n`
        + baselineErrors.map((error) => `- ${error}`).join('\n'),
      );
    }
    baselineQuestionIds = new Set(baselineManifest.questionIds);

    const releasePath = path.resolve(
      process.cwd(),
      args.baseline
        ? path.join(path.dirname(args.baseline), 'release-v1.json')
        : DEFAULT_RELEASE,
    );
    let releaseInput: unknown;
    try {
      releaseInput = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
    } catch (error) {
      throw new Error(
        `${releasePath}: unable to read release manifest (${error instanceof Error ? error.message : 'unknown error'})`,
      );
    }
    let releaseManifest: ReturnType<typeof parseOpenUsmleReleaseManifest>;
    try {
      releaseManifest = parseOpenUsmleReleaseManifest(releaseInput);
    } catch (error) {
      throw new Error(
        `${releasePath}: invalid release manifest (${error instanceof Error ? error.message : 'unknown error'})`,
      );
    }
    const releaseErrors = validateOpenUsmleReleaseMembership(
      releaseManifest,
      new Set(loaded.questions.map((question) => question.id)),
    );
    const recomputedFingerprints = buildPublicUsmleReleaseFingerprints(loaded.questions, {
      baselineQuestionIds,
    });
    const releaseFingerprintErrors = validateOpenUsmleReleaseFingerprints(
      releaseManifest,
      recomputedFingerprints,
    );
    if (!args.writeReleaseFingerprints) {
      releaseErrors.push(...releaseFingerprintErrors);
    }
    if (releaseErrors.length > 0) {
      throw new Error(
        `${releasePath}: release validation failed (${releaseErrors.length} issue(s)):\n`
        + releaseErrors.map((error) => `- ${error}`).join('\n'),
      );
    }
    releaseRefresh = {
      path: releasePath,
      manifest: releaseManifest,
      fingerprints: recomputedFingerprints,
    };
  }

  const mechanicalFlawQuestionIds = new Set(
    loaded.questions
      .filter((question) => checkItem({
        id: question.id,
        stem: question.stem,
        options: question.options.map((option) => ({
          label: option.label,
          text: option.text,
        })),
        answer: question.options.find((option) => option.isCorrect)?.label,
        source: question.sourceFile,
      }).some((hit) => hit.severity === 'flaw'))
      .map((question) => question.id),
  );

  const report = buildPublicUsmleSourceAudit(
    loaded.questions,
    new Set(exclusions.ids),
    sourceRegistry,
    {
      membersOnly: args.membersOnly,
      baselineQuestionIds,
      mechanicalFlawQuestionIds,
    },
  );

  if (!options.silent) {
    if (args.json) console.log(JSON.stringify(report));
    else printHumanSummary(report);
  }

  const out = options.silent ? null : (args.out ?? (args.json ? null : DEFAULT_OUT));
  if (out) {
    const outPath = path.resolve(process.cwd(), out);
    writeReport(outPath, report);
    if (!args.json) console.log(`  report: ${outPath}`);
  }

  const releaseFailures = args.releaseGate
    ? [
        ...publicUsmleReleaseGateFailures(report, args.minEligible),
        ...openUsmleSourceReceiptFailures(sourceRegistry),
      ]
    : [];
  let releaseFingerprintWrite: PublicUsmleAuditRunResult['releaseFingerprintWrite'] = null;
  if (
    args.writeReleaseFingerprints
    && releaseFailures.length === 0
    && releaseRefresh
  ) {
    const refreshed = parseOpenUsmleReleaseManifest({
      schemaVersion: releaseRefresh.manifest.schemaVersion,
      questionIds: releaseRefresh.manifest.questionIds,
      questionFingerprints: releaseRefresh.fingerprints,
    });
    replaceJsonAtomically(releaseRefresh.path, refreshed);
    releaseFingerprintWrite = {
      path: releaseRefresh.path,
      count: refreshed.questionIds.length,
    };
    if (!options.silent) {
      console.log(
        `  refreshed ${refreshed.questionIds.length} source-derived release fingerprint(s): `
        + releaseRefresh.path,
      );
    }
  }
  return { report, releaseFailures, releaseFingerprintWrite };
}

function main(): void {
  const result = runPublicUsmleAudit(process.argv.slice(2));
  if (result.releaseFailures.length > 0) {
    for (const failure of result.releaseFailures) console.error(`release gate: ${failure}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
