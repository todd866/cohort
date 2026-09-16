/**
 * Audit Trigger System
 *
 * Automatically creates AgentJobs based on audit findings.
 * Implements trigger rules from docs/designs/2026-01-28-manifold-audit-infrastructure.md
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

export interface AuditOutput {
  timestamp: Date;
  userId: string | null;
  rotation: string;
  metrics: {
    coverage?: {
      totalExamPoints: number;
      coveragePercent: number;
      strongPoints: number;
      mediumPoints: number;
      weakPoints: number;
      coldPoints: number;
      userCoveredPoints: number;
      weekCoverage: Array<{
        week: number | null;
        total: number;
        exposed: number;
        avgStrength: number;
        cold: number;
      }>;
    };
    geometric?: {
      l2Distance: number;
      cosineSimilarity: number;
      weakestRegions: Array<{
        description: string;
        userStrength: number;
        targetStrength: number;
        gap: number;
      }>;
    };
    contentDensity: {
      sparseRegions: Array<{
        description: string;
        contentCount: number;
        userStrength?: number;
        priority: 'URGENT' | 'HIGH' | 'MEDIUM' | 'LOW';
      }>;
      averageVariationsPerConcept: number;
      conceptsWithSingleCard: number;
      struggleRegionsWithoutAlternatives: Array<{
        cardId: string;
        failCount: number;
        alternativesWithinRadius: number;
      }>;
    };
    feedbackLoop?: {
      totalLoops: number;
      loopSuccessRate: number;
      successfulLoops: number;
      failedLoops: number;
    };
  };
  health: {
    overall: 'HEALTHY' | 'NEEDS_ATTENTION' | 'CRITICAL';
    issues: Array<{
      type: string;
      severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
      description: string;
      metric: string;
      value: number;
      threshold: number;
    }>;
  };
  actions: Array<{
    type: string;
    priority: 'URGENT' | 'HIGH' | 'MEDIUM' | 'LOW';
    description: string;
    automatable: boolean;
    agentJobType?: string;
    context?: Record<string, unknown>;
  }>;
}

interface TriggerRule {
  name: string;
  condition: (output: AuditOutput) => boolean;
  jobType: string;
  priority: number; // 1=urgent, 2=normal, 3=low
  triggerName: string;
  contextBuilder: (output: AuditOutput) => Record<string, unknown>;
}

/**
 * Trigger Rules
 *
 * These rules automatically create AgentJobs when conditions are met.
 */
const TRIGGER_RULES: TriggerRule[] = [
  {
    name: 'sparse_weak_region',
    condition: (output) =>
      output.metrics.contentDensity.sparseRegions.some(
        (r) => r.priority === 'URGENT' && (r.userStrength ?? 0) < 0.3
      ),
    jobType: 'generate_content',
    priority: 1, // urgent
    triggerName: 'audit_sparse_weak_region',
    contextBuilder: (output) => {
      const urgentRegions = output.metrics.contentDensity.sparseRegions.filter(
        (r) => r.priority === 'URGENT' && (r.userStrength ?? 0) < 0.3
      );
      return {
        regions: urgentRegions.map((r) => ({
          description: r.description,
          contentCount: r.contentCount,
          userStrength: r.userStrength,
        })),
        rotation: output.rotation,
        userId: output.userId,
      };
    },
  },
  {
    name: 'failed_loops',
    condition: (output) =>
      output.metrics.feedbackLoop !== undefined &&
      output.metrics.feedbackLoop.totalLoops > 5 &&
      output.metrics.feedbackLoop.loopSuccessRate < 0.5,
    jobType: 'investigate_failures',
    priority: 1, // urgent
    triggerName: 'audit_failed_loops',
    contextBuilder: (output) => ({
      loopSuccessRate: output.metrics.feedbackLoop!.loopSuccessRate,
      totalLoops: output.metrics.feedbackLoop!.totalLoops,
      failedLoops: output.metrics.feedbackLoop!.failedLoops,
      rotation: output.rotation,
      userId: output.userId,
    }),
  },
  {
    name: 'repeated_failures',
    condition: (output) =>
      output.metrics.contentDensity.struggleRegionsWithoutAlternatives.length > 0,
    jobType: 'generate_content',
    priority: 1, // urgent
    triggerName: 'audit_repeated_failure',
    contextBuilder: (output) => ({
      cards: output.metrics.contentDensity.struggleRegionsWithoutAlternatives.map(
        (s) => ({
          cardId: s.cardId,
          failCount: s.failCount,
          alternatives: s.alternativesWithinRadius,
        })
      ),
      rotation: output.rotation,
      userId: output.userId,
    }),
  },
];

export interface TriggeredJob {
  id: string;
  type: string;
  priority: number;
  trigger: string;
  metadata: Record<string, unknown>;
}

/**
 * Process audit output and create AgentJobs for triggered rules
 */
export async function processAuditTriggers(
  auditOutput: AuditOutput
): Promise<TriggeredJob[]> {
  const jobs: TriggeredJob[] = [];

  for (const rule of TRIGGER_RULES) {
    if (rule.condition(auditOutput)) {
      const metadata = rule.contextBuilder(auditOutput);

      // Create AgentJob
      const job = await prisma.agentJob.create({
        data: {
          type: rule.jobType,
          priority: rule.priority,
          trigger: rule.triggerName,
          rotation: auditOutput.rotation,
          metadata: metadata as Prisma.InputJsonValue,
          createdAt: new Date(),
        },
      });

      jobs.push({
        id: job.id,
        type: job.type,
        priority: job.priority,
        trigger: job.trigger,
        metadata: (job.metadata ?? {}) as Record<string, unknown>,
      });
    }
  }

  return jobs;
}

/**
 * Get summary of created jobs
 */
export function getJobsSummary(jobs: TriggeredJob[]): string {
  if (jobs.length === 0) {
    return 'No jobs created - system is healthy';
  }

  const lines = [`Created ${jobs.length} AgentJob(s):\n`];

  for (const job of jobs) {
    const priorityLabel = job.priority === 1 ? 'URGENT' : job.priority === 2 ? 'NORMAL' : 'LOW';
    const emoji = job.priority === 1 ? '🔴' : job.priority === 2 ? '⚠️ ' : '🟡';
    lines.push(`  ${emoji} [${priorityLabel}] ${job.type} (ID: ${job.id.slice(0, 8)})`);

    // Add metadata details
    lines.push(`     Trigger: ${job.trigger}`);
    const regions = job.metadata.regions as Array<{ description: string }> | undefined;
    if (regions) {
      lines.push(
        `     Regions: ${regions.length} (${regions.map((r) => r.description).join(', ')})`
      );
    }
    const cards = job.metadata.cards as Array<{ cardId: string }> | undefined;
    if (cards) {
      lines.push(
        `     Cards: ${cards.length} (${cards.map((c) => c.cardId.slice(0, 8)).join(', ')})`
      );
    }
  }

  return lines.join('\n');
}
