import fs from 'node:fs';
import path from 'node:path';
import {
  decidePublicUsmleQuestion,
  buildQuestionCitationEnvelope,
} from '@/lib/usmle/public-corpus';
import {
  parseOpenUsmleBaselineManifest,
  USMLE_STEP1_BASELINE_V1_MODULE,
  validateOpenUsmleBaselineReferences,
} from '@/lib/usmle/public-baseline';
export { USMLE_STEP1_BASELINE_V1_MODULE } from '@/lib/usmle/public-baseline';
import {
  parseOpenUsmleSourceRegistry,
  validateOpenUsmleSourceReference,
} from '@/lib/usmle/open-source-registry';
import {
  parseOpenUsmleReleaseManifest,
  validateOpenUsmleReleaseFingerprints,
  validateOpenUsmleReleaseMembership,
  type OpenUsmleReleaseManifest,
} from '@/lib/usmle/public-release';
import { buildPublicUsmleReleaseFingerprints } from '@/lib/usmle/public-serving-drift';
import {
  DEFAULT_QUESTION_BANK_DIR,
  loadQuestionBankFromDisk,
} from './load';
import type { CuratedQuestion } from './types';

export const DEFAULT_OPEN_USMLE_ROOT = path.join(
  process.cwd(),
  'open-content',
  'usmle',
  'step1',
);
export const DEFAULT_OPEN_USMLE_QUESTION_BANK_DIR = path.join(
  DEFAULT_OPEN_USMLE_ROOT,
  'questions',
);
export const DEFAULT_OPEN_USMLE_SOURCE_REGISTRY_PATH = path.join(
  DEFAULT_OPEN_USMLE_ROOT,
  'sources.json',
);
export const DEFAULT_OPEN_USMLE_BASELINE_MANIFEST_PATH = path.join(
  DEFAULT_OPEN_USMLE_ROOT,
  'baseline-v1.json',
);
export const DEFAULT_OPEN_USMLE_RELEASE_MANIFEST_PATH = path.join(
  DEFAULT_OPEN_USMLE_ROOT,
  'release-v1.json',
);

export interface LoadedSeedQuestionCorpus {
  files: string[];
  questions: CuratedQuestion[];
  errors: string[];
}

/**
 * Load the redistributable Step 1 bank without touching the private sibling.
 *
 * This is deliberately stricter than the generic bank loader: every question
 * must pass the canonical rights/provenance decision and resolve its evidence
 * pointer against the checked-in source registry. Release is evidence-gated,
 * not dependent on a named human sign-off.
 */
export function loadOpenUsmleQuestionBankFromDisk(options: {
  bankDir?: string;
  sourceRegistryPath?: string;
  baselineManifestPath?: string;
  releaseManifestPath?: string;
} = {}): LoadedSeedQuestionCorpus {
  const bankDir = options.bankDir ?? DEFAULT_OPEN_USMLE_QUESTION_BANK_DIR;
  const sourceRegistryPath = options.sourceRegistryPath
    ?? DEFAULT_OPEN_USMLE_SOURCE_REGISTRY_PATH;
  const baselineManifestPath = options.baselineManifestPath
    ?? DEFAULT_OPEN_USMLE_BASELINE_MANIFEST_PATH;
  const releaseManifestPath = options.releaseManifestPath
    ?? DEFAULT_OPEN_USMLE_RELEASE_MANIFEST_PATH;
  const loaded = loadQuestionBankFromDisk({
    bankDir,
    allowUnregisteredRootDirs: true,
  });
  if (loaded.errors.length > 0) {
    return { files: loaded.files, questions: [], errors: loaded.errors };
  }

  let registry: ReturnType<typeof parseOpenUsmleSourceRegistry>;
  try {
    const raw = fs.readFileSync(sourceRegistryPath, 'utf8');
    registry = parseOpenUsmleSourceRegistry(JSON.parse(raw) as unknown);
  } catch (error) {
    return {
      files: loaded.files,
      questions: [],
      errors: [
        `${sourceRegistryPath}: invalid open-USMLE source registry (${error instanceof Error ? error.message : String(error)})`,
      ],
    };
  }

  let baselineQuestionIds: string[];
  try {
    const raw = fs.readFileSync(baselineManifestPath, 'utf8');
    baselineQuestionIds = parseOpenUsmleBaselineManifest(
      JSON.parse(raw) as unknown,
    ).questionIds;
  } catch (error) {
    return {
      files: [...loaded.files, sourceRegistryPath].sort(),
      questions: [],
      errors: [
        `${baselineManifestPath}: invalid Step 1 baseline manifest (${error instanceof Error ? error.message : String(error)})`,
      ],
    };
  }

  const questionIds = new Set(loaded.questions.map((question) => question.id));
  const baselineReferenceErrors = validateOpenUsmleBaselineReferences(
    { schemaVersion: 1, questionIds: baselineQuestionIds },
    questionIds,
  );
  if (baselineReferenceErrors.length > 0) {
    return {
      files: [...loaded.files, sourceRegistryPath, baselineManifestPath].sort(),
      questions: [],
      errors: baselineReferenceErrors.map(
        (message) => `${baselineManifestPath}: ${message}`,
      ),
    };
  }

  let releaseManifest: OpenUsmleReleaseManifest;
  try {
    const raw = fs.readFileSync(releaseManifestPath, 'utf8');
    releaseManifest = parseOpenUsmleReleaseManifest(JSON.parse(raw) as unknown);
  } catch (error) {
    return {
      files: [...loaded.files, sourceRegistryPath, baselineManifestPath].sort(),
      questions: [],
      errors: [
        `${releaseManifestPath}: invalid Step 1 release manifest (${error instanceof Error ? error.message : String(error)})`,
      ],
    };
  }
  const releaseMembershipErrors = validateOpenUsmleReleaseMembership(
    releaseManifest,
    questionIds,
  );
  if (releaseMembershipErrors.length > 0) {
    return {
      files: [
        ...loaded.files,
        sourceRegistryPath,
        baselineManifestPath,
        releaseManifestPath,
      ].sort(),
      questions: [],
      errors: releaseMembershipErrors.map(
        (message) => `${releaseManifestPath}: ${message}`,
      ),
    };
  }
  const baselineIdSet = new Set(baselineQuestionIds);
  const projectedQuestions = loaded.questions.map((question): CuratedQuestion => (
    baselineIdSet.has(question.id)
      ? {
          ...question,
          moduleNodes: Array.from(new Set([
            ...(question.moduleNodes ?? []),
            USMLE_STEP1_BASELINE_V1_MODULE,
          ])),
        }
      : question
  ));

  const releaseFingerprintErrors = validateOpenUsmleReleaseFingerprints(
    releaseManifest,
    buildPublicUsmleReleaseFingerprints(projectedQuestions),
  );
  if (releaseFingerprintErrors.length > 0) {
    return {
      files: [
        ...loaded.files,
        sourceRegistryPath,
        baselineManifestPath,
        releaseManifestPath,
      ].sort(),
      questions: [],
      errors: releaseFingerprintErrors.map(
        (message) => `${releaseManifestPath}: ${message}`,
      ),
    };
  }

  const errors: string[] = [];
  for (const question of projectedQuestions) {
    const decision = decidePublicUsmleQuestion({
      id: question.id,
      rotation: question.rotation,
      moduleNodes: question.moduleNodes ?? [],
      source: 'bank',
      sourceFile: question.sourceFile ?? null,
      imageUrl: question.imageUrl ?? null,
      contentState: 'enhanced',
      excluded: false,
      citations: buildQuestionCitationEnvelope(question.cite, question.publicUsmle),
      annotations: question.annotations ?? null,
    });
    if (!decision.eligible) {
      errors.push(
        `${question.sourceFile ?? question.id}: public eligibility ${decision.reason} (${decision.detail})`,
      );
      continue;
    }

    const sourceErrors = validateOpenUsmleSourceReference(
      registry,
      decision.provenance.evidence,
    );
    for (const sourceError of sourceErrors) {
      errors.push(`${question.sourceFile ?? question.id}: ${sourceError}`);
    }
  }

  return {
    files: [
      ...loaded.files,
      sourceRegistryPath,
      baselineManifestPath,
      releaseManifestPath,
    ].sort(),
    questions: errors.length === 0 ? projectedQuestions : [],
    errors,
  };
}

/**
 * Compose the existing private bank and repo-native open bank for normal MD3
 * seeding. Each loader keeps its own semantics; duplicate IDs across roots are
 * fatal so neither source can silently overwrite the other.
 */
export function loadSeedQuestionBanksFromDisk(options: {
  privateBankDir?: string;
  openBankDir?: string;
  sourceRegistryPath?: string;
  baselineManifestPath?: string;
  releaseManifestPath?: string;
} = {}): LoadedSeedQuestionCorpus {
  const privateBank = loadQuestionBankFromDisk({
    bankDir: options.privateBankDir ?? DEFAULT_QUESTION_BANK_DIR,
  });
  const openBank = loadOpenUsmleQuestionBankFromDisk({
    bankDir: options.openBankDir ?? DEFAULT_OPEN_USMLE_QUESTION_BANK_DIR,
    sourceRegistryPath: options.sourceRegistryPath
      ?? DEFAULT_OPEN_USMLE_SOURCE_REGISTRY_PATH,
    baselineManifestPath: options.baselineManifestPath
      ?? DEFAULT_OPEN_USMLE_BASELINE_MANIFEST_PATH,
    releaseManifestPath: options.releaseManifestPath
      ?? DEFAULT_OPEN_USMLE_RELEASE_MANIFEST_PATH,
  });
  const errors = [...privateBank.errors, ...openBank.errors];
  if (errors.length > 0) {
    return {
      files: [...privateBank.files, ...openBank.files].sort(),
      questions: [],
      errors,
    };
  }

  const privateIds = new Set(privateBank.questions.map((question) => question.id));
  const duplicateIds = openBank.questions
    .map((question) => question.id)
    .filter((id) => privateIds.has(id))
    .sort();
  if (duplicateIds.length > 0) {
    return {
      files: [...privateBank.files, ...openBank.files].sort(),
      questions: [],
      errors: duplicateIds.map(
        (id) => `duplicate question id ${id} across private and open roots`,
      ),
    };
  }

  return {
    files: [...privateBank.files, ...openBank.files].sort(),
    questions: [...privateBank.questions, ...openBank.questions],
    errors: [],
  };
}
