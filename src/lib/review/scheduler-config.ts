const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type ExamDateInput = Date | string | null | undefined;

export function parseExamDate(value: ExamDateInput): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function getConfiguredExamDateForRotation(
  _rotation: string | undefined,
): Date | null {
  void _rotation;
  return null;
}

export function startOfUtcDayMs(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function subtractUtcDays(dayMs: number, days: number): number {
  return dayMs - days * MS_PER_DAY;
}
