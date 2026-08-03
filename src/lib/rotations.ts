import { prisma } from '@/lib/prisma';
import { PERSONAL_DECKS, personalDeckSlugs } from '@/lib/personal-decks';

export interface RotationConfig {
  id: string;
  name: string;
  shortName: string;
  weeks: number;
  defaultExamDate: Date;
  color: string;
}

export const ROTATIONS: RotationConfig[] = [];
export const USYD_ROTATION_IDS: string[] = [];
export const USMLE_ROTATION_IDS = ['usmle-step1'] as const;
export const YEAR3_COMMON_ROTATION_IDS: string[] = [];
export const PERSONAL_ROTATION_IDS: string[] = personalDeckSlugs();
export const SELF_PACED_EXAM_SENTINEL = new Date('2099-12-31T00:00:00Z');

export function isSelfPacedExamDate(date: Date | null | undefined): boolean {
  return date != null && date.getTime() >= SELF_PACED_EXAM_SENTINEL.getTime();
}

const PERSONAL_ROTATION_CONFIG: Record<string, RotationConfig> = Object.fromEntries(
  PERSONAL_DECKS.map((deck) => [deck.slug, {
    id: deck.slug,
    name: deck.name,
    shortName: deck.shortName,
    weeks: deck.weeks,
    defaultExamDate: deck.examDate
      ? new Date(`${deck.examDate}T00:00:00Z`)
      : SELF_PACED_EXAM_SENTINEL,
    color: deck.color,
  }]),
);

export const CONTENT_ROTATION_IDS = [
  ...USMLE_ROTATION_IDS,
  ...PERSONAL_ROTATION_IDS,
];
export const EXAM_PREP_ROTATION_IDS: string[] = [];

export function resolveModuleRotation(_year: string, _discipline: string): string {
  void _year;
  void _discipline;
  return 'usmle-step1';
}

export function getRotation(id: string): RotationConfig | undefined {
  return PERSONAL_ROTATION_CONFIG[id] ?? ROTATIONS.find((rotation) => rotation.id === id);
}

export async function getExamDateForUser(
  rotationId: string,
  userId?: string,
): Promise<Date | null> {
  if (userId) {
    try {
      const userRotation = await prisma.userRotation.findUnique({
        where: { userId_rotation: { userId, rotation: rotationId } },
      });
      if (userRotation?.examDate) return userRotation.examDate;
    } catch {
      // Fall through to explicit public configuration.
    }
  }
  return getRotation(rotationId)?.defaultExamDate ?? null;
}

export function getExamDate(rotationId: string): Date | null {
  return getRotation(rotationId)?.defaultExamDate ?? null;
}

export function getDaysUntilExam(rotationId: string): number | null {
  const examDate = getExamDate(rotationId);
  if (!examDate) return null;
  return Math.ceil((examDate.getTime() - Date.now()) / 86_400_000);
}

export async function getDaysUntilExamForUser(
  rotationId: string,
  userId?: string,
): Promise<number | null> {
  const examDate = await getExamDateForUser(rotationId, userId);
  if (!examDate) return null;
  return Math.ceil((examDate.getTime() - Date.now()) / 86_400_000);
}

export async function getUserRotations(userId: string): Promise<string[]> {
  try {
    const rows = await prisma.userRotation.findMany({
      where: { userId },
      select: { rotation: true },
    });
    return rows.map((row) => row.rotation);
  } catch {
    return [];
  }
}

export async function getCurrentRotation(_userId: string): Promise<string | null> {
  void _userId;
  return null;
}

export async function getCurrentRotationWithDetails(_userId: string): Promise<{
  rotation: string;
  startDate: Date;
  examDate: Date;
  weekNumber: number;
  daysUntilExam: number;
} | null> {
  void _userId;
  return null;
}
