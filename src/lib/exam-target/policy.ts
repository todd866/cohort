import type {
  ExamTargetAnchorSupport,
  ExamTargetBasis,
  ExamTargetDefinition,
  ExamTargetInfluencePolicy,
  ExamTargetRegistrySource,
} from './types';

export function anchorSupportFromCount(anchorCount: number): ExamTargetAnchorSupport {
  if (!Number.isInteger(anchorCount) || anchorCount < 0) {
    throw new Error(`anchorCount must be a non-negative integer; received ${anchorCount}`);
  }
  if (anchorCount >= 3) return 'sufficient';
  if (anchorCount === 2) return 'provisional';
  if (anchorCount === 1) return 'sparse';
  return 'missing';
}

function targetBasisFor(source: ExamTargetRegistrySource): ExamTargetBasis {
  if (source.weightPolicy.kind === 'proxy-shrunk-anchor-share') return 'proxy';
  const geometryIsOfficial = source.evidence.geometry.every(
    (ref) => ref.authority === 'official-assessment-report',
  );
  return geometryIsOfficial ? 'official' : 'hybrid';
}

function influenceFor(
  source: ExamTargetRegistrySource,
  targetBasis: ExamTargetBasis,
): ExamTargetInfluencePolicy {
  if (source.servingStatus === 'shadow' || source.servingStatus === 'retired') {
    return {
      allocator: 'shadow',
      maxItemRankMove: 0,
      conceptMultiplierMin: 1,
      conceptMultiplierMax: 1,
    };
  }
  if (targetBasis === 'proxy') {
    return {
      allocator: 'soft',
      maxItemRankMove: 1,
      conceptMultiplierMin: 0.9,
      conceptMultiplierMax: 1.1,
    };
  }
  if (targetBasis === 'hybrid' || source.servingStatus === 'limited') {
    return {
      allocator: 'soft',
      maxItemRankMove: 2,
      conceptMultiplierMin: 0.9,
      conceptMultiplierMax: 1.1,
    };
  }
  return {
    allocator: 'full',
    maxItemRankMove: 5,
    conceptMultiplierMin: 0.67,
    conceptMultiplierMax: 1.75,
  };
}

export function materializeExamTarget(
  source: ExamTargetRegistrySource,
): ExamTargetDefinition {
  const targetBasis = targetBasisFor(source);
  let domains: ExamTargetDefinition['domains'];

  if (source.weightPolicy.kind === 'official-question-count') {
    const totalQuestions = source.weightPolicy.totalQuestions;
    const questionTotal = source.domains.reduce(
      (sum, domain) => sum + (domain.questionCount ?? 0),
      0,
    );
    if (questionTotal !== totalQuestions) {
      throw new Error(
        `${source.rotation} official domain counts total ${questionTotal}; expected ${totalQuestions}`,
      );
    }
    domains = source.domains.map((domain) => {
      if (domain.questionCount == null) {
        throw new Error(`${source.rotation}.${domain.code} is missing questionCount`);
      }
      const weight = domain.questionCount / totalQuestions;
      return {
        ...domain,
        rawWeight: weight,
        effectiveWeight: weight,
        weightAuthority: 'official' as const,
        anchorSupport: anchorSupportFromCount(domain.anchorCount),
      };
    });
  } else {
    const proxyShare = source.weightPolicy.proxyShare;
    const totalAnchors = source.domains.reduce(
      (sum, domain) => sum + domain.anchorCount,
      0,
    );
    if (totalAnchors <= 0) {
      throw new Error(`${source.rotation} proxy target has no anchors`);
    }
    const uniformShare = 1 / source.domains.length;
    domains = source.domains.map((domain) => {
      const rawWeight = domain.anchorCount / totalAnchors;
      const effectiveWeight =
        proxyShare * rawWeight
        + (1 - proxyShare) * uniformShare;
      return {
        ...domain,
        rawWeight,
        effectiveWeight,
        weightAuthority: 'proxy' as const,
        anchorSupport: anchorSupportFromCount(domain.anchorCount),
      };
    });
  }

  const { weightPolicy, ...base } = source;
  void weightPolicy;
  return {
    ...base,
    targetBasis,
    domains,
    influence: influenceFor(source, targetBasis),
  };
}
