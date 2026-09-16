/**
 * Manifold Heat Field
 *
 * Models knowledge as a continuous heat field on the embedding space.
 *
 * Key dynamics:
 * 1. Heat Injection: Reviews deposit heat at concept locations
 * 2. Diffusion: Heat spreads to semantically similar concepts
 * 3. Decay: Heat dissipates over time (forgetting curve)
 * 4. Capacity: Diminishing returns on daily cramming
 *
 * The "temperature" at any point represents how well the user
 * can recall that knowledge RIGHT NOW - not just that they've seen it.
 */

import type { ExtendedPrismaClient } from '@/lib/prisma';

// Heat field configuration
export const HEAT_CONFIG = {
  // Decay half-life in days (how fast heat dissipates without reinforcement)
  decayHalfLifeDays: 7,

  // Maximum heat per region (0-1 scale)
  maxHeat: 1.0,

  // Daily capacity - how much total heat can be added per day
  // Uses logarithmic diminishing returns
  dailyCapacityBase: 0.3, // First reviews of day are most effective
  dailyCapacityDecay: 0.7, // Each subsequent review is 70% as effective

  // Transfer coefficient - how much heat spreads to adjacent concepts
  transferCoefficient: 0.2,

  // Minimum similarity for heat transfer
  transferThreshold: 0.6,
} as const;

// Heat state for a single region (week/topic/concept)
export interface HeatRegion {
  id: string;
  name: string;
  type: 'week' | 'topic' | 'concept';

  // Current heat (0-1)
  heat: number;

  // Components
  baseHeat: number; // From direct reviews
  transferredHeat: number; // From adjacent regions
  decayedAmount: number; // Lost to decay since last review

  // Metadata
  cardCount: number;
  reviewCount: number;
  lastReviewAt: Date | null;
  avgRecallProbability: number;
}

// Full heat field state
export interface HeatField {
  userId: string;
  rotation: string;
  computedAt: Date;

  // Overall stats
  totalHeat: number; // Sum of all region heat
  maxPossibleHeat: number; // If everything was at 1.0
  coveragePercent: number; // totalHeat / maxPossibleHeat

  // Heat by week
  weeklyHeat: HeatRegion[];

  // Heat by topic (top N)
  topicHeat: HeatRegion[];

  // Daily capacity remaining
  dailyCapacityUsed: number;
  dailyCapacityRemaining: number;

  // Temporal dynamics
  heatAddedToday: number;
  projectedHeatTomorrow: number; // After overnight decay
  projectedHeatOnExamDay: number;

  // Exam context
  daysUntilExam: number | null;
  examDate: Date | null;
}

/**
 * Calculate heat from recall probability and time since last review
 */
function calculateHeat(
  recallProbability: number,
  lastReviewAt: Date | null,
  now: Date
): { heat: number; decayed: number } {
  if (!lastReviewAt) {
    return { heat: 0, decayed: 0 };
  }

  const daysSinceReview =
    (now.getTime() - lastReviewAt.getTime()) / (1000 * 60 * 60 * 24);

  // Exponential decay based on half-life
  const decayFactor = Math.pow(0.5, daysSinceReview / HEAT_CONFIG.decayHalfLifeDays);

  // Base heat is recall probability, then apply decay
  const baseHeat = recallProbability;
  const currentHeat = baseHeat * decayFactor;
  const decayed = baseHeat - currentHeat;

  return {
    heat: Math.max(0, Math.min(HEAT_CONFIG.maxHeat, currentHeat)),
    decayed: Math.max(0, decayed),
  };
}

/**
 * Calculate daily capacity used and remaining
 * Returns { used, remaining, effectiveness }
 */
function calculateDailyCapacity(reviewsToday: number): {
  used: number;
  remaining: number;
  nextReviewEffectiveness: number;
} {
  // Each review adds heat but with diminishing returns
  // Integral of effectiveness function gives total heat added
  // effectiveness(n) = 1 / (1 + 0.02 * n)
  // integral from 0 to n = 50 * ln(1 + 0.02n)

  const effectivenessDecay = 0.02;
  const maxDailyHeat = 1.0; // Maximum achievable in one day

  // Total heat accumulated from n reviews
  const heatFromReviews = (n: number) =>
    Math.min(maxDailyHeat, (1 / effectivenessDecay) * Math.log(1 + effectivenessDecay * n) * 0.05);

  const used = heatFromReviews(reviewsToday);
  const remaining = Math.max(0, maxDailyHeat - used);
  const nextReviewEffectiveness = 1 / (1 + effectivenessDecay * reviewsToday);

  return { used, remaining, nextReviewEffectiveness };
}

/**
 * Project heat on a future date (e.g., exam day)
 */
function projectHeatOnDate(currentHeat: number, daysInFuture: number): number {
  const decayFactor = Math.pow(0.5, daysInFuture / HEAT_CONFIG.decayHalfLifeDays);
  return currentHeat * decayFactor;
}

/**
 * Compute the full heat field for a user and rotation
 */
export async function computeHeatField(
  prisma: ExtendedPrismaClient,
  userId: string,
  rotation: string,
  examDate?: Date
): Promise<HeatField> {
  const now = new Date();

  // Get all concept states for this user and rotation
  const conceptStates = await prisma.conceptState.findMany({
    where: {
      userId,
      concept: { rotation },
    },
    include: {
      concept: {
        select: {
          id: true,
          name: true,
          week: true,
          topics: true,
          examWeight: true,
        },
      },
    },
  });

  // Get card progress for additional context
  const cardProgress = await prisma.cardProgress.findMany({
    where: {
      userId,
      card: { rotation },
    },
    include: {
      card: {
        select: {
          week: true,
          topics: true,
        },
      },
    },
  });

  // Get today's review count for capacity calculation
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const todayReviews = await prisma.learningEvent.count({
    where: {
      userId,
      timestamp: { gte: todayStart },
      eventType: { in: ['card_review', 'concept_probe'] },
    },
  });

  // Aggregate by week
  const weekMap = new Map<number | null, {
    cards: typeof cardProgress;
    concepts: typeof conceptStates;
  }>();

  for (const cp of cardProgress) {
    const week = cp.card.week;
    if (!weekMap.has(week)) {
      weekMap.set(week, { cards: [], concepts: [] });
    }
    const weekEntry = weekMap.get(week);
    if (weekEntry) weekEntry.cards.push(cp);
  }

  for (const cs of conceptStates) {
    const week = cs.concept.week;
    if (week !== null) {
      if (!weekMap.has(week)) {
        weekMap.set(week, { cards: [], concepts: [] });
      }
      const weekConceptEntry = weekMap.get(week);
      if (weekConceptEntry) weekConceptEntry.concepts.push(cs);
    }
  }

  // Calculate weekly heat
  const weeklyHeat: HeatRegion[] = [];
  let totalHeat = 0;
  let maxPossibleHeat = 0;

  for (const [week, data] of Array.from(weekMap.entries()).sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))) {
    const cardCount = data.cards.length;
    const reviewCount = data.cards.reduce((sum, cp) => sum + cp.totalReviews, 0);

    // Calculate heat from concept states
    let weekHeat = 0;
    let totalRecallProb = 0;
    let lastReview: Date | null = null;
    let decayedTotal = 0;

    for (const cs of data.concepts) {
      const { heat, decayed } = calculateHeat(
        cs.recallProbability,
        cs.lastProbeAt,
        now
      );
      weekHeat += heat * (cs.concept.examWeight || 1);
      totalRecallProb += cs.recallProbability;
      decayedTotal += decayed;

      if (cs.lastProbeAt && (!lastReview || cs.lastProbeAt > lastReview)) {
        lastReview = cs.lastProbeAt;
      }
    }

    // Also factor in card progress for cards without concept states
    for (const cp of data.cards) {
      // Simple heat from card progress: reviewing status contributes
      const statusHeat =
        cp.status === 'mastered' ? 0.9 :
        cp.status === 'reviewing' ? 0.6 :
        cp.status === 'learning' ? 0.3 : 0;

      if (cp.lastReview) {
        const { heat } = calculateHeat(statusHeat, cp.lastReview, now);
        weekHeat += heat * 0.5; // Cards contribute less than concepts

        if (!lastReview || cp.lastReview > lastReview) {
          lastReview = cp.lastReview;
        }
      }
    }

    // Normalize heat to 0-1 range based on content volume
    const maxWeekHeat = (data.concepts.length * 5 + data.cards.length * 0.5);
    const normalizedHeat = maxWeekHeat > 0 ? Math.min(1, weekHeat / maxWeekHeat) : 0;

    weeklyHeat.push({
      id: `week-${week}`,
      name: `Week ${week}`,
      type: 'week',
      heat: normalizedHeat,
      baseHeat: normalizedHeat,
      transferredHeat: 0, // Will compute transfer later
      decayedAmount: decayedTotal,
      cardCount,
      reviewCount,
      lastReviewAt: lastReview,
      avgRecallProbability:
        data.concepts.length > 0 ? totalRecallProb / data.concepts.length : 0,
    });

    totalHeat += normalizedHeat;
    maxPossibleHeat += 1;
  }

  // Aggregate by topic
  const topicMap = new Map<string, {
    cards: typeof cardProgress;
    concepts: typeof conceptStates;
  }>();

  for (const cp of cardProgress) {
    for (const topic of cp.card.topics) {
      if (!topicMap.has(topic)) {
        topicMap.set(topic, { cards: [], concepts: [] });
      }
      const topicEntry = topicMap.get(topic);
      if (topicEntry) topicEntry.cards.push(cp);
    }
  }

  for (const cs of conceptStates) {
    for (const topic of cs.concept.topics) {
      if (!topicMap.has(topic)) {
        topicMap.set(topic, { cards: [], concepts: [] });
      }
      const topicConceptEntry = topicMap.get(topic);
      if (topicConceptEntry) topicConceptEntry.concepts.push(cs);
    }
  }

  // Calculate topic heat (top 20 by card count)
  const topicHeat: HeatRegion[] = [];
  const sortedTopics = Array.from(topicMap.entries())
    .sort((a, b) => b[1].cards.length - a[1].cards.length)
    .slice(0, 20);

  for (const [topic, data] of sortedTopics) {
    const cardCount = data.cards.length;
    const reviewCount = data.cards.reduce((sum, cp) => sum + cp.totalReviews, 0);

    let topicHeatVal = 0;
    let totalRecallProb = 0;
    let lastReview: Date | null = null;

    for (const cs of data.concepts) {
      const { heat } = calculateHeat(cs.recallProbability, cs.lastProbeAt, now);
      topicHeatVal += heat * (cs.concept.examWeight || 1);
      totalRecallProb += cs.recallProbability;

      if (cs.lastProbeAt && (!lastReview || cs.lastProbeAt > lastReview)) {
        lastReview = cs.lastProbeAt;
      }
    }

    for (const cp of data.cards) {
      const statusHeat =
        cp.status === 'mastered' ? 0.9 :
        cp.status === 'reviewing' ? 0.6 :
        cp.status === 'learning' ? 0.3 : 0;

      if (cp.lastReview) {
        const { heat } = calculateHeat(statusHeat, cp.lastReview, now);
        topicHeatVal += heat * 0.5;

        if (!lastReview || cp.lastReview > lastReview) {
          lastReview = cp.lastReview;
        }
      }
    }

    const maxTopicHeat = (data.concepts.length * 5 + data.cards.length * 0.5);
    const normalizedHeat = maxTopicHeat > 0 ? Math.min(1, topicHeatVal / maxTopicHeat) : 0;

    topicHeat.push({
      id: `topic-${topic}`,
      name: topic,
      type: 'topic',
      heat: normalizedHeat,
      baseHeat: normalizedHeat,
      transferredHeat: 0,
      decayedAmount: 0,
      cardCount,
      reviewCount,
      lastReviewAt: lastReview,
      avgRecallProbability:
        data.concepts.length > 0 ? totalRecallProb / data.concepts.length : 0,
    });
  }

  // Sort topic heat by heat value (hottest first)
  topicHeat.sort((a, b) => b.heat - a.heat);

  // Calculate daily capacity
  const dailyCapacity = calculateDailyCapacity(todayReviews);
  const dailyCapacityUsed = dailyCapacity.used;
  const dailyCapacityRemaining = dailyCapacity.remaining;

  // Calculate temporal projections
  const avgHeat = maxPossibleHeat > 0 ? totalHeat / maxPossibleHeat : 0;
  const projectedHeatTomorrow = projectHeatOnDate(avgHeat, 1);

  let daysUntilExam: number | null = null;
  let projectedHeatOnExamDay = avgHeat;

  if (examDate) {
    daysUntilExam = Math.ceil(
      (examDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );
    projectedHeatOnExamDay = projectHeatOnDate(avgHeat, daysUntilExam);
  }

  // Get heat added today from learning events
  const todayEvents = await prisma.learningEvent.findMany({
    where: {
      userId,
      timestamp: { gte: todayStart },
      eventType: { in: ['card_review', 'concept_probe'] },
    },
    select: { quality: true },
  });

  const heatAddedToday = todayEvents.reduce((sum, e) => {
    // Quality 0-5 maps to heat contribution
    const qualityHeat = (e.quality || 3) / 5 * 0.1;
    return sum + qualityHeat;
  }, 0);

  return {
    userId,
    rotation,
    computedAt: now,
    totalHeat,
    maxPossibleHeat,
    coveragePercent: maxPossibleHeat > 0 ? (totalHeat / maxPossibleHeat) * 100 : 0,
    weeklyHeat,
    topicHeat,
    dailyCapacityUsed,
    dailyCapacityRemaining,
    heatAddedToday,
    projectedHeatTomorrow,
    projectedHeatOnExamDay,
    daysUntilExam,
    examDate: examDate || null,
  };
}

/**
 * Format heat as a visual bar
 */
export function formatHeatBar(heat: number, width: number = 10): string {
  const filled = Math.round(heat * width);
  const empty = width - filled;

  // Use gradient characters for heat intensity
  if (heat > 0.8) {
    return '🔥'.repeat(Math.ceil(filled / 2)) + '░'.repeat(empty);
  } else if (heat > 0.5) {
    return '█'.repeat(filled) + '░'.repeat(empty);
  } else if (heat > 0.2) {
    return '▓'.repeat(filled) + '░'.repeat(empty);
  } else {
    return '░'.repeat(width);
  }
}

/**
 * Generate ASCII heat map for terminal display
 */
export function formatHeatField(field: HeatField): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════');
  lines.push('              KNOWLEDGE HEAT FIELD                  ');
  lines.push('═══════════════════════════════════════════════════');
  lines.push(`Rotation: ${field.rotation.toUpperCase()}`);
  lines.push(`Computed: ${field.computedAt.toLocaleString()}`);
  if (field.daysUntilExam !== null) {
    lines.push(`Exam: ${field.daysUntilExam} days away`);
  }
  lines.push('');

  // Overall coverage
  const overallBar = formatHeatBar(field.coveragePercent / 100, 20);
  lines.push(`Overall Coverage: ${overallBar} ${Math.round(field.coveragePercent)}%`);
  lines.push('');

  // Weekly heat
  lines.push('📅 WEEKLY HEAT');
  lines.push('───────────────────────────────────────────────────');
  for (const week of field.weeklyHeat) {
    const bar = formatHeatBar(week.heat, 15);
    const pct = Math.round(week.heat * 100);
    const lastReview = week.lastReviewAt
      ? `(last: ${formatTimeAgo(week.lastReviewAt)})`
      : '(no reviews)';
    lines.push(`  ${week.name.padEnd(8)} ${bar} ${pct.toString().padStart(3)}% ${lastReview}`);
  }
  lines.push('');

  // Top topics
  lines.push('🏷️  TOP TOPICS (by heat)');
  lines.push('───────────────────────────────────────────────────');
  for (const topic of field.topicHeat.slice(0, 10)) {
    const bar = formatHeatBar(topic.heat, 10);
    const pct = Math.round(topic.heat * 100);
    lines.push(`  ${topic.name.slice(0, 20).padEnd(20)} ${bar} ${pct.toString().padStart(3)}%`);
  }
  lines.push('');

  // Temporal projections
  lines.push('⏱️  TEMPORAL DYNAMICS');
  lines.push('───────────────────────────────────────────────────');
  lines.push(`  Heat added today:      ${(field.heatAddedToday * 100).toFixed(1)}%`);
  lines.push(`  Daily capacity left:   ${(field.dailyCapacityRemaining * 100).toFixed(1)}%`);
  lines.push(`  Tomorrow (after decay): ${(field.projectedHeatTomorrow * 100).toFixed(1)}%`);
  if (field.daysUntilExam !== null) {
    lines.push(`  On exam day:           ${(field.projectedHeatOnExamDay * 100).toFixed(1)}%`);
  }
  lines.push('═══════════════════════════════════════════════════');

  return lines.join('\n');
}

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  if (diffHours < 1) return 'just now';
  if (diffHours < 24) return `${Math.round(diffHours)}h ago`;
  if (diffDays < 7) return `${Math.round(diffDays)}d ago`;
  return `${Math.round(diffDays / 7)}w ago`;
}
