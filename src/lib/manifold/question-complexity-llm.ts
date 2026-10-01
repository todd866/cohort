/**
 * LLM-Based Question Complexity Scorer
 *
 * Uses Claude to analyze question complexity with better nuance than regex.
 * Falls back to regex-based scoring when LLM is unavailable or for batch operations.
 *
 * Key advantages over regex:
 * - Understands semantic relationships between concepts
 * - Detects subtle cross-domain integration
 * - Evaluates distractor quality more accurately
 * - Catches nuance that patterns miss (e.g., "requires integrating 3 concepts")
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  ComplexityProfile,
  ComplexitySignals,
  CognitiveTask,
  analyzeComplexity as regexAnalyze,
  extractSignals,
} from './question-complexity';
import { logger } from '@/lib/logger';

// Simple in-memory cache for development (TTL: 1 hour)
const cache = new Map<string, { profile: LLMComplexityResult; timestamp: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface LLMComplexityResult {
  // Core dimensions (same as ComplexityProfile for compatibility)
  vignetteComplexity: number;
  domainIntegration: number;
  cognitiveLoad: number;
  informationDensity: number;
  distractorPlausibility: number;
  overallComplexity: number;

  // LLM-specific insights
  reasoning: string;
  detectedDomains: string[];
  taskType: CognitiveTask;
  conceptCount: number;
  requiresMultiStepReasoning: boolean;
  clinicalRealism: 'low' | 'medium' | 'high';
  estimatedTimeSeconds: number;

  // Source tracking
  source: 'llm' | 'regex' | 'hybrid';
}

const COMPLEXITY_PROMPT = `You are analyzing the complexity of a medical exam question. Your task is to accurately assess how difficult this question would be for a medical student.

Rate each dimension from 0.0 to 1.0:

1. **Vignette Complexity** (0-1): How complex is the clinical scenario?
   - 0.0-0.2: No vignette, just a direct question or simple fact recall
   - 0.3-0.4: Simple patient presentation (age, sex, chief complaint)
   - 0.5-0.6: Moderate vignette with relevant history and findings
   - 0.7-0.8: Complex case with multiple relevant details to synthesize
   - 0.9-1.0: Multi-layered case requiring synthesis of many clinical elements

2. **Domain Integration** (0-1): How many medical domains must be integrated?
   - 0.0-0.2: Single isolated fact (e.g., "What drug treats X?")
   - 0.3-0.4: Single domain knowledge application
   - 0.5-0.6: Two domains connected (e.g., diabetes + nephrology)
   - 0.7-0.8: Multiple domains with interaction effects
   - 0.9-1.0: Complex cross-domain integration (3+ domains with interdependencies)

3. **Cognitive Load** (0-1): What level of reasoning is required?
   - 0.0-0.2: Pure recall of a single fact
   - 0.3-0.4: Application of a single concept
   - 0.5-0.6: Analysis required (interpretation of data)
   - 0.7-0.8: Evaluation/judgment with competing considerations
   - 0.9-1.0: Complex synthesis or multi-step reasoning

4. **Information Density** (0-1): How much relevant information must be processed?
   - Consider: ratio of relevant to irrelevant information, number of data points
   - High density = lots of relevant data in compact form

5. **Distractor Quality** (0-1): How plausible are the wrong answers?
   - 0.0-0.3: Obviously wrong distractors, easy elimination
   - 0.4-0.6: Plausible but distinguishable with knowledge
   - 0.7-1.0: All options require careful differentiation, common misconceptions

QUESTION:
{stem}

OPTIONS:
{options}

Respond with ONLY valid JSON (no markdown, no explanation before/after):
{
  "vignetteComplexity": <0-1>,
  "domainIntegration": <0-1>,
  "cognitiveLoad": <0-1>,
  "informationDensity": <0-1>,
  "distractorPlausibility": <0-1>,
  "reasoning": "<1-2 sentence explanation of your rating>",
  "detectedDomains": ["<domain1>", "<domain2>"],
  "taskType": "<diagnosis|next-step|management|mechanism|interpretation|identification|prognosis|risk-assessment>",
  "conceptCount": <number of distinct medical concepts needed>,
  "requiresMultiStepReasoning": <true|false>,
  "clinicalRealism": "<low|medium|high>",
  "estimatedTimeSeconds": <reasonable time for a competent student>
}`;

/**
 * Generate a cache key from question content
 */
function getCacheKey(stem: string, options: Array<{ text: string }>): string {
  const content = stem + '|' + options.map((o) => o.text).join('|');
  // Simple hash for cache key
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `complexity_${hash}`;
}

/**
 * Check cache for existing result
 */
function checkCache(key: string): LLMComplexityResult | null {
  const cached = cache.get(key);
  if (!cached) return null;

  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }

  return cached.profile;
}

/**
 * Store result in cache
 */
function setCache(key: string, profile: LLMComplexityResult): void {
  cache.set(key, { profile, timestamp: Date.now() });
}

/**
 * Analyze question complexity using Claude
 *
 * Returns LLM-based complexity scoring with detailed reasoning.
 * Falls back to regex if API call fails.
 */
export async function analyzeComplexityLLM(
  stem: string,
  options: Array<{ text: string; label?: string }>,
  config?: {
    useCache?: boolean;
    fallbackToRegex?: boolean;
    model?: string;
  }
): Promise<LLMComplexityResult> {
  const { useCache = true, fallbackToRegex = true, model = 'claude-sonnet-4-20250514' } = config ?? {};

  // Check cache first
  const cacheKey = getCacheKey(stem, options);
  if (useCache) {
    const cached = checkCache(cacheKey);
    if (cached) {
      return cached;
    }
  }

  try {
    const anthropic = new Anthropic();

    // Format options for the prompt
    const optionsText = options
      .map((o, i) => `${String.fromCharCode(65 + i)}. ${o.text}`)
      .join('\n');

    const prompt = COMPLEXITY_PROMPT
      .replace('{stem}', stem)
      .replace('{options}', optionsText);

    const response = await anthropic.messages.create({
      model,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type');
    }

    // Parse JSON response
    const parsed = JSON.parse(content.text) as {
      vignetteComplexity: number;
      domainIntegration: number;
      cognitiveLoad: number;
      informationDensity: number;
      distractorPlausibility: number;
      reasoning: string;
      detectedDomains: string[];
      taskType: CognitiveTask;
      conceptCount: number;
      requiresMultiStepReasoning: boolean;
      clinicalRealism: 'low' | 'medium' | 'high';
      estimatedTimeSeconds: number;
    };

    // Calculate overall complexity with same weights as regex version
    const overallComplexity =
      parsed.vignetteComplexity * 0.15 +
      parsed.domainIntegration * 0.25 +
      parsed.cognitiveLoad * 0.30 +
      parsed.informationDensity * 0.15 +
      parsed.distractorPlausibility * 0.15;

    const result: LLMComplexityResult = {
      ...parsed,
      overallComplexity,
      source: 'llm',
    };

    if (useCache) {
      setCache(cacheKey, result);
    }

    return result;
  } catch (error) {
    logger.warn('LLM complexity analysis failed', { error: String(error) });

    if (fallbackToRegex) {
      return convertRegexToLLMResult(regexAnalyze(stem, options));
    }

    throw error;
  }
}

/**
 * Convert regex-based result to LLMComplexityResult format
 */
function convertRegexToLLMResult(profile: ComplexityProfile): LLMComplexityResult {
  const signals = profile.signals;

  return {
    vignetteComplexity: profile.vignetteComplexity,
    domainIntegration: profile.domainIntegration,
    cognitiveLoad: profile.cognitiveLoad,
    informationDensity: profile.informationDensity,
    distractorPlausibility: profile.distractorPlausibility,
    overallComplexity: profile.overallComplexity,
    reasoning: 'Analyzed using regex-based pattern matching',
    detectedDomains: signals.domains,
    taskType: signals.taskType,
    conceptCount: signals.domains.length + (signals.requiresSynthesis ? 2 : 1),
    requiresMultiStepReasoning: signals.requiresSynthesis,
    clinicalRealism: signals.hasPatientAge && signals.hasExamFindings ? 'high' : 'medium',
    estimatedTimeSeconds: Math.round(signals.stemWordCount * 1.5 + signals.optionCount * 5),
    source: 'regex',
  };
}

/**
 * Hybrid analysis - uses LLM for nuanced scoring, regex for structural signals
 *
 * Best of both worlds:
 * - LLM: semantic understanding, distractor quality, reasoning depth
 * - Regex: fast signal extraction, reliable pattern detection
 */
export async function analyzeComplexityHybrid(
  stem: string,
  options: Array<{ text: string; label?: string }>
): Promise<LLMComplexityResult & { signals: ComplexitySignals }> {
  // Get structural signals via regex (fast, reliable)
  const signals = extractSignals(stem, options);

  // Get semantic analysis via LLM
  const llmResult = await analyzeComplexityLLM(stem, options);

  // Blend results - trust LLM for semantic, regex for structure
  return {
    ...llmResult,
    source: 'hybrid',
    // Override domains if regex found more (regex is more reliable for pattern matching)
    detectedDomains:
      signals.domains.length > llmResult.detectedDomains.length
        ? signals.domains
        : llmResult.detectedDomains,
    signals,
  };
}

/**
 * Batch analyze questions with rate limiting
 *
 * For large batches, uses regex with optional LLM spot-checks.
 */
export async function batchAnalyzeComplexity(
  questions: Array<{ stem: string; options: Array<{ text: string }> }>,
  config?: {
    useLLM?: boolean;
    llmSampleRate?: number; // 0-1, what fraction to analyze with LLM
    concurrency?: number;
    onProgress?: (completed: number, total: number) => void;
  }
): Promise<LLMComplexityResult[]> {
  const {
    useLLM = false,
    llmSampleRate = 0.1,
    concurrency = 5,
    onProgress,
  } = config ?? {};

  const results: LLMComplexityResult[] = [];
  let completed = 0;

  // Process in batches for concurrency control
  for (let i = 0; i < questions.length; i += concurrency) {
    const batch = questions.slice(i, i + concurrency);

    const batchResults = await Promise.all(
      batch.map(async (q) => {
        const shouldUseLLM = useLLM && Math.random() < llmSampleRate;

        if (shouldUseLLM) {
          return analyzeComplexityLLM(q.stem, q.options);
        } else {
          const regexResult = regexAnalyze(q.stem, q.options);
          return convertRegexToLLMResult(regexResult);
        }
      })
    );

    results.push(...batchResults);
    completed += batch.length;

    if (onProgress) {
      onProgress(completed, questions.length);
    }

    // Rate limiting between batches if using LLM
    if (useLLM && i + concurrency < questions.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return results;
}

/**
 * Compare LLM vs regex scoring for calibration validation
 *
 * Useful for understanding where LLM and regex diverge.
 */
export async function compareScorers(
  stem: string,
  options: Array<{ text: string }>
): Promise<{
  llm: LLMComplexityResult;
  regex: LLMComplexityResult;
  divergence: number;
  divergenceByDimension: Record<string, number>;
}> {
  const [llm, regexProfile] = await Promise.all([
    analyzeComplexityLLM(stem, options, { fallbackToRegex: false }),
    Promise.resolve(convertRegexToLLMResult(regexAnalyze(stem, options))),
  ]);

  const dimensions = [
    'vignetteComplexity',
    'domainIntegration',
    'cognitiveLoad',
    'informationDensity',
    'distractorPlausibility',
  ] as const;

  const divergenceByDimension: Record<string, number> = {};
  let totalDivergence = 0;

  for (const dim of dimensions) {
    const diff = Math.abs(llm[dim] - regexProfile[dim]);
    divergenceByDimension[dim] = diff;
    totalDivergence += diff;
  }

  return {
    llm,
    regex: regexProfile,
    divergence: totalDivergence / dimensions.length,
    divergenceByDimension,
  };
}

/**
 * Clear the complexity cache
 */
export function clearCache(): void {
  cache.clear();
}

/**
 * Get cache statistics
 */
export function getCacheStats(): { size: number; oldestMs: number } {
  let oldest = Date.now();
  for (const entry of cache.values()) {
    if (entry.timestamp < oldest) {
      oldest = entry.timestamp;
    }
  }

  return {
    size: cache.size,
    oldestMs: Date.now() - oldest,
  };
}
