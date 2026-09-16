/**
 * Question Analysis ("Talk Page") Generator
 *
 * Creates rich annotations for questions explaining:
 * - What the question tests and why
 * - Concept connections and prerequisites
 * - Common misconceptions it targets
 * - How it relates to clinical practice
 *
 * Used for:
 * 1. Understanding exam patterns
 * 2. Auditing our question bank against exam standards
 * 3. Identifying coverage gaps
 * 4. Training content authors on exam-style questions
 */

import { ComplexityProfile, CognitiveTask, analyzeComplexity } from './question-complexity';

export interface QuestionAnalysis {
  // Identity
  questionId?: string;
  stem: string;
  options: Array<{ text: string; isCorrect?: boolean }>;

  // Complexity profile
  complexity: ComplexityProfile;

  // What it tests
  primaryConcept: string;
  secondaryConcepts: string[];
  prerequisites: string[];

  // Why it's testing this way
  cognitiveSkill: CognitiveTask;
  clinicalReasoning: string;
  discriminationTarget: string; // What separates good students from struggling ones

  // Connections
  relatedTopics: string[];
  clinicalScenarios: string[]; // Real-world situations where this matters
  commonMisconceptions: string[];

  // Exam context
  examRelevance: 'high' | 'medium' | 'low';
  frequencyEstimate: 'common' | 'occasional' | 'rare';
  difficultyRationale: string;

  // For our question bank
  coverageGaps: string[]; // What we might be missing
  suggestedVariations: string[]; // Ways to create related questions
}

/**
 * Cognitive skill descriptions for different task types
 */
const COGNITIVE_SKILL_DESCRIPTIONS: Record<CognitiveTask, string> = {
  'diagnosis': 'Pattern recognition from clinical features to disease',
  'next-step': 'Sequential clinical reasoning and prioritization',
  'management': 'Treatment selection based on patient context',
  'mechanism': 'Understanding pathophysiology and causal relationships',
  'interpretation': 'Data analysis and clinical correlation',
  'identification': 'Recognition of specific findings or features',
  'prognosis': 'Risk stratification and outcome prediction',
  'risk-assessment': 'Identifying and weighing risk factors',
  'unknown': 'General medical knowledge application',
};

/**
 * Generate a question analysis from LLM output
 *
 * This is the structured format for storing analysis results.
 * The actual analysis content comes from LLM processing.
 */
export function createQuestionAnalysis(
  stem: string,
  options: Array<{ text: string; isCorrect?: boolean }>,
  llmAnalysis: {
    primaryConcept: string;
    secondaryConcepts: string[];
    prerequisites: string[];
    clinicalReasoning: string;
    discriminationTarget: string;
    relatedTopics: string[];
    clinicalScenarios: string[];
    commonMisconceptions: string[];
    examRelevance: 'high' | 'medium' | 'low';
    frequencyEstimate: 'common' | 'occasional' | 'rare';
    difficultyRationale: string;
    coverageGaps: string[];
    suggestedVariations: string[];
  }
): QuestionAnalysis {
  const complexity = analyzeComplexity(stem, options);

  return {
    stem,
    options,
    complexity,
    cognitiveSkill: complexity.signals.taskType,
    ...llmAnalysis,
  };
}

/**
 * Format analysis as markdown for human review
 */
export function formatAnalysisMarkdown(analysis: QuestionAnalysis): string {
  const lines: string[] = [];

  lines.push('# Question Analysis\n');

  // Question
  lines.push('## Question\n');
  lines.push(`**Stem:** ${analysis.stem}\n`);
  lines.push('**Options:**');
  for (const opt of analysis.options) {
    const marker = opt.isCorrect ? '✓' : '○';
    lines.push(`- ${marker} ${opt.text}`);
  }
  lines.push('');

  // What it tests
  lines.push('## What This Tests\n');
  lines.push(`**Primary Concept:** ${analysis.primaryConcept}\n`);
  if (analysis.secondaryConcepts.length > 0) {
    lines.push(`**Secondary Concepts:** ${analysis.secondaryConcepts.join(', ')}\n`);
  }
  if (analysis.prerequisites.length > 0) {
    lines.push(`**Prerequisites:** ${analysis.prerequisites.join(', ')}\n`);
  }

  // Cognitive skill
  lines.push('## Cognitive Skill\n');
  lines.push(`**Task Type:** ${analysis.cognitiveSkill}`);
  lines.push(`> ${COGNITIVE_SKILL_DESCRIPTIONS[analysis.cognitiveSkill]}\n`);
  lines.push(`**Clinical Reasoning:** ${analysis.clinicalReasoning}\n`);
  lines.push(`**What Separates Strong from Weak:** ${analysis.discriminationTarget}\n`);

  // Complexity
  lines.push('## Complexity Profile\n');
  lines.push(`| Dimension | Score |`);
  lines.push(`|-----------|-------|`);
  lines.push(`| Vignette | ${analysis.complexity.vignetteComplexity.toFixed(2)} |`);
  lines.push(`| Domain Integration | ${analysis.complexity.domainIntegration.toFixed(2)} |`);
  lines.push(`| Cognitive Load | ${analysis.complexity.cognitiveLoad.toFixed(2)} |`);
  lines.push(`| Information Density | ${analysis.complexity.informationDensity.toFixed(2)} |`);
  lines.push(`| Distractor Quality | ${analysis.complexity.distractorPlausibility.toFixed(2)} |`);
  lines.push(`| **Overall** | **${analysis.complexity.overallComplexity.toFixed(2)}** |`);
  lines.push('');
  lines.push(`**Difficulty Rationale:** ${analysis.difficultyRationale}\n`);

  // Connections
  lines.push('## Connections\n');
  if (analysis.relatedTopics.length > 0) {
    lines.push(`**Related Topics:** ${analysis.relatedTopics.join(', ')}\n`);
  }
  if (analysis.clinicalScenarios.length > 0) {
    lines.push('**When This Matters Clinically:**');
    for (const scenario of analysis.clinicalScenarios) {
      lines.push(`- ${scenario}`);
    }
    lines.push('');
  }

  // Misconceptions
  if (analysis.commonMisconceptions.length > 0) {
    lines.push('## Common Misconceptions\n');
    for (const misconception of analysis.commonMisconceptions) {
      lines.push(`- ${misconception}`);
    }
    lines.push('');
  }

  // Exam context
  lines.push('## Exam Context\n');
  lines.push(`**Relevance:** ${analysis.examRelevance}`);
  lines.push(`**Frequency:** ${analysis.frequencyEstimate}\n`);

  // For our bank
  if (analysis.coverageGaps.length > 0 || analysis.suggestedVariations.length > 0) {
    lines.push('## For Our Question Bank\n');
    if (analysis.coverageGaps.length > 0) {
      lines.push('**Coverage Gaps:**');
      for (const gap of analysis.coverageGaps) {
        lines.push(`- ${gap}`);
      }
      lines.push('');
    }
    if (analysis.suggestedVariations.length > 0) {
      lines.push('**Suggested Variations:**');
      for (const variation of analysis.suggestedVariations) {
        lines.push(`- ${variation}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * The prompt template for generating question analysis
 *
 * Use this with Claude to generate the analysis content.
 */
export const QUESTION_ANALYSIS_PROMPT = `You are analyzing a medical exam question to create a detailed "talk page" that explains what it tests and why.

QUESTION:
{stem}

OPTIONS:
{options}

CORRECT ANSWER (if known): {answer}

Analyze this question and provide a JSON response with the following structure:

{
  "primaryConcept": "The main medical concept being tested (e.g., 'Diabetic nephropathy progression')",
  "secondaryConcepts": ["Other concepts needed to answer correctly"],
  "prerequisites": ["Knowledge the student must have before attempting this"],
  "clinicalReasoning": "Explain the clinical thinking process to arrive at the answer",
  "discriminationTarget": "What specifically separates students who get this right from those who don't",
  "relatedTopics": ["Topics that connect to this question"],
  "clinicalScenarios": ["Real clinical situations where this knowledge matters"],
  "commonMisconceptions": ["Errors students commonly make on this type of question"],
  "examRelevance": "high|medium|low",
  "frequencyEstimate": "common|occasional|rare",
  "difficultyRationale": "Why this question is easy/medium/hard",
  "coverageGaps": ["What related content we might be missing in our question bank"],
  "suggestedVariations": ["Ways to create related questions testing similar concepts"]
}

Be specific and clinically accurate. The analysis should help content authors understand how to create exam-quality questions.`;

/**
 * Generate analysis for a single question
 *
 * This is the entry point for analyzing questions with Claude.
 * In practice, you'd call this within a Claude Code session.
 */
export function getAnalysisPrompt(
  stem: string,
  options: Array<{ text: string }>,
  correctAnswer?: string
): string {
  const optionsText = options
    .map((o, i) => `${String.fromCharCode(65 + i)}. ${o.text}`)
    .join('\n');

  return QUESTION_ANALYSIS_PROMPT
    .replace('{stem}', stem)
    .replace('{options}', optionsText)
    .replace('{answer}', correctAnswer || 'Not specified');
}
