/**
 * User Profile API
 *
 * GET - Get current user profile with stats
 * PATCH - Update user profile/preferences
 *
 * Heavy query logic extracted to src/lib/user/ for testability.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { PERSONAL_ROTATION_IDS, ROTATIONS, getCurrentRotation } from '@/lib/rotations';
import { requireAuth } from '@/lib/api-utils';
import { checkUserRateLimit } from '@/lib/rate-limit';
import { userIdCanAccessRequestedRotations } from '@/lib/personal-rotation-access';
import {
  getCardStats,
  getRecentActivity,
  getWeeklyStats,
  getRotationStatsOptimized,
  getConceptMastery,
  getWeeklyProgress,
} from '@/lib/user/stats-queries';
import { seedInitialQueue } from '@/lib/user/queue-seeding';

const feedProfileExplicitSchema = z.object({
  studying: z.string().max(100).optional(),
  year: z.string().max(100).optional(),
  school: z.string().max(200).optional(),
}).strict();

const profilePatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  cohort: z.number().int().min(1).max(12).nullable().optional(),
  medSchool: z.string().trim().max(200).nullable().optional(),
  studyGoal: z.number().int().min(0).max(5000).nullable().optional(),
  darkMode: z.boolean().optional(),
  emailDigest: z.boolean().optional(),
  institution: z.string().trim().max(50).nullable().optional(),
  enabledModules: z.array(z.string().trim().min(1)).optional(),
  jurisdiction: z.string().trim().max(20).nullable().optional(),
  examDates: z.record(z.string().trim().min(1)).optional(),
  feedProfileExplicit: feedProfileExplicitSchema.optional(),
  resetProgressOnInstitutionChange: z.boolean().optional(),
});

type ProfilePatchInput = z.infer<typeof profilePatchSchema>;

export async function GET() {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const userId = auth.userId;

  const rl = await checkUserRateLimit(userId, 'user', 30, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  try {
    const currentRotation = await getCurrentRotation(userId);
    const canAccessPersonalRotations = await userIdCanAccessRequestedRotations(
      userId,
      PERSONAL_ROTATION_IDS,
    );
    const broadStatsScope = canAccessPersonalRotations
      ? undefined
      : { excludeRotations: PERSONAL_ROTATION_IDS };

    const [
      user,
      cardStats,
      rotationStats,
      weeklyStats,
      recentActivity,
      conceptMastery,
      weeklyProgress,
    ] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        include: { rotations: true },
      }),
      getCardStats(userId, currentRotation, broadStatsScope),
      getRotationStatsOptimized(userId),
      getWeeklyStats(userId),
      getRecentActivity(userId, broadStatsScope),
      getConceptMastery(userId, currentRotation, broadStatsScope),
      getWeeklyProgress(userId, currentRotation),
    ]);

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const currentStreak = user.currentStreak;
    const longestStreak = user.longestStreak;

    const userExamDates = new Map(user.rotations.map(ur => [ur.rotation, ur.examDate]));
    const rotationProgress = ROTATIONS.map((rotation) => {
      const stats = rotationStats.get(rotation.id) || {
        totalCards: 0,
        studiedCards: 0,
        avgMastery: 0,
        dueCards: 0,
      };

      const examDate = userExamDates.get(rotation.id) || rotation.defaultExamDate;
      const daysToExam = Math.ceil(
        (examDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      );

      return {
        id: rotation.id,
        name: rotation.name,
        shortName: rotation.shortName,
        color: rotation.color,
        examDate: examDate.toISOString().split('T')[0],
        daysToExam,
        totalCards: stats.totalCards,
        studiedCards: stats.studiedCards,
        coverage: stats.totalCards > 0
          ? Math.round((stats.studiedCards / stats.totalCards) * 100)
          : 0,
        mastery: Math.round(stats.avgMastery * 100),
        dueCards: stats.dueCards,
      };
    });

    const feedProfile = (user.feedProfile as Record<string, unknown>) || {};
    const feedProfileExplicit = (feedProfile.explicit || {}) as Record<string, unknown>;
    const feedProfileImplicit = (feedProfile.implicit || {}) as Record<string, unknown>;
    const pollAnswers = (feedProfileImplicit.pollAnswers || {}) as Record<string, string>;

    return NextResponse.json({
      profile: {
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        cohort: user.cohort,
        medSchool: user.medSchool,
        studyGoal: user.studyGoal,
        darkMode: user.darkMode,
        emailDigest: user.emailDigest,
        institution: user.institution,
        enabledModules: user.enabledModules,
        jurisdiction: user.jurisdiction,
        createdAt: user.createdAt,
        feedProfileExplicit: {
          studying: feedProfileExplicit.studying as string | undefined,
          year: feedProfileExplicit.year as string | undefined,
          school: feedProfileExplicit.school as string | undefined,
        },
        pollAnswers,
      },
      currentRotation,
      stats: {
        totalStudyTime: user.totalStudyTime,
        currentStreak,
        longestStreak,
        lastActiveAt: user.lastActiveAt,
        ...cardStats,
      },
      rotations: rotationProgress,
      recentActivity,
      weeklyStats,
      conceptMastery,
      weeklyProgress,
    });
  } catch (error) {
    logger.error('Profile error', { userId, error: String(error) });
    return NextResponse.json(
      { error: 'Failed to get profile' },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const userId = auth.userId;

  try {
    const rawBody = await request.json();
    const parseResult = profilePatchSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: parseResult.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const updates = parseResult.data;

    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { institution: true },
    });
    const nextInstitution =
      typeof updates.institution === 'string' && updates.institution.length > 0
        ? updates.institution
        : null;
    const isNewInstitution = !!nextInstitution && !currentUser?.institution;
    const institutionChanged = !!nextInstitution && currentUser?.institution !== nextInstitution;

    if (updates.examDates && typeof updates.examDates === 'object') {
      const examDateEntries = Object.entries(updates.examDates);
      for (const [rotationId, dateStr] of examDateEntries) {
        const parsedDate = new Date(dateStr);
        if (Number.isNaN(parsedDate.getTime())) {
          return NextResponse.json(
            { error: `Invalid exam date for rotation '${rotationId}'` },
            { status: 400 }
          );
        }
      }

      await Promise.all(
        examDateEntries.map(([rotationId, dateStr]) => {
          const parsedDate = new Date(dateStr);
          return prisma.userRotation.upsert({
            where: {
              userId_rotation: {
                userId,
                rotation: rotationId,
              },
            },
            create: {
              userId,
              rotation: rotationId,
              startDate: new Date(),
              examDate: parsedDate,
            },
            update: {
              examDate: parsedDate,
            },
          });
        })
      );
    }

    if (updates.feedProfileExplicit) {
      const existing = await prisma.user.findUnique({
        where: { id: userId },
        select: { feedProfile: true },
      });
      const feedProfile = (existing?.feedProfile as Record<string, unknown>) || {};
      const explicit = (feedProfile.explicit || {}) as Record<string, unknown>;

      for (const [key, value] of Object.entries(updates.feedProfileExplicit)) {
        if (value === '') {
          delete explicit[key];
        } else if (value !== undefined) {
          explicit[key] = value;
        }
      }

      const implicit = (feedProfile.implicit || {}) as Record<string, unknown>;

      await prisma.user.update({
        where: { id: userId },
        data: { feedProfile: { ...feedProfile, explicit, implicit } },
      });
    }

    const sanitizedUpdates = toUserUpdateData(updates);
    const hasProfileUpdates = Object.keys(sanitizedUpdates).length > 0;

    let user: {
      id: string;
      name: string | null;
      cohort: number | null;
      medSchool: string | null;
      studyGoal: number | null;
      darkMode: boolean;
      emailDigest: boolean;
      institution: string | null;
      enabledModules: string[];
      jurisdiction: string | null;
    } | null;

    const selectFields = {
      id: true,
      name: true,
      cohort: true,
      medSchool: true,
      studyGoal: true,
      darkMode: true,
      emailDigest: true,
      institution: true,
      enabledModules: true,
      jurisdiction: true,
    } as const;

    if (hasProfileUpdates) {
      user = await prisma.user.update({
        where: { id: userId },
        data: sanitizedUpdates,
        select: selectFields,
      });
    } else {
      user = await prisma.user.findUnique({
        where: { id: userId },
        select: selectFields,
      });
    }

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if ((isNewInstitution || institutionChanged) && nextInstitution) {
      await seedInitialQueue(userId, nextInstitution, {
        resetExistingProgress: updates.resetProgressOnInstitutionChange === true,
      });
    }

    return NextResponse.json({
      success: true,
      profile: {
        id: user.id,
        name: user.name,
        cohort: user.cohort,
        medSchool: user.medSchool,
        studyGoal: user.studyGoal,
        darkMode: user.darkMode,
        emailDigest: user.emailDigest,
        institution: user.institution,
        enabledModules: user.enabledModules,
        jurisdiction: user.jurisdiction,
      },
    });
  } catch (error) {
    logger.error('Profile update error', { userId, error: String(error) });
    return NextResponse.json(
      { error: 'Failed to update profile' },
      { status: 500 }
    );
  }
}

function toUserUpdateData(updates: ProfilePatchInput): Record<string, unknown> {
  const allowedFields = [
    'name',
    'cohort',
    'medSchool',
    'studyGoal',
    'darkMode',
    'emailDigest',
    'institution',
    'enabledModules',
    'jurisdiction',
  ] as const;

  const sanitizedUpdates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    const value = updates[field];
    if (value !== undefined) {
      sanitizedUpdates[field] = value;
    }
  }
  return sanitizedUpdates;
}
