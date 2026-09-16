// Metadata for all rotations and their weeks
import rotationData from './rotation-metadata.json';

export interface WeekMeta {
  title: string;
  topics: string[];
  contentFile: string;
}

export interface SubrotationMeta {
  slug: string;
  title: string;
  description: string;
  /** Display topics shown as pills on the subrotation page */
  topics: string[];
  /** Longer topic list for ReviewModeProvider filtering */
  reviewTopics: string[];
  emoji: string;
  /** Tailwind gradient class for the landing page card */
  cardColor: string;
}

export interface ExtraSection {
  href: string;
  title: string;
  subtitle: string;
  emoji: string;
  className: string;
}

export interface RotationMeta {
  id: string;
  name: string;
  shortName: string;
  emoji: string;
  color: string;
  /** Tailwind bg class for the header icon (e.g. 'bg-red-500') */
  bgClass: string;
  weeks: Record<number, WeekMeta>;
  subrotations: SubrotationMeta[];
  /** Grid columns for subrotation cards on landing page */
  subrotationGridCols: 2 | 3 | 4;
  /** Optional extra sections on the landing page (e.g. Skills Practice for CC) */
  extraSections?: ExtraSection[];
}

export const ROTATIONS: Record<string, RotationMeta> = rotationData as Record<string, RotationMeta>;

export function getRotation(rotationId: string): RotationMeta | null {
  return ROTATIONS[rotationId] || null;
}

export function getWeekMeta(rotationId: string, weekNum: number): (WeekMeta & { prevWeek: number | null; nextWeek: number | null }) | null {
  const rotation = ROTATIONS[rotationId];
  if (!rotation) return null;

  const week = rotation.weeks[weekNum];
  if (!week) return null;

  const weekNums = Object.keys(rotation.weeks).map(Number).sort((a, b) => a - b);
  const currentIndex = weekNums.indexOf(weekNum);

  return {
    ...week,
    prevWeek: currentIndex > 0 ? weekNums[currentIndex - 1] : null,
    nextWeek: currentIndex < weekNums.length - 1 ? weekNums[currentIndex + 1] : null,
  };
}

export function getWeekCount(rotationId: string): number {
  const rotation = ROTATIONS[rotationId];
  return rotation ? Object.keys(rotation.weeks).length : 0;
}

export function getSubrotation(rotationId: string, slug: string): SubrotationMeta | null {
  const rotation = ROTATIONS[rotationId];
  if (!rotation) return null;
  return rotation.subrotations.find((s) => s.slug === slug) || null;
}

export function getSubrotations(rotationId: string): SubrotationMeta[] {
  const rotation = ROTATIONS[rotationId];
  return rotation?.subrotations || [];
}
