import { personalDeckLabels } from '@/lib/personal-decks';

export const ROTATION_LABELS: Record<string, string> = {
  'usmle-step1': 'USMLE',
  ...personalDeckLabels(),
};

export function rotationLabel(slug: string): string {
  return ROTATION_LABELS[slug] ?? slug.toUpperCase();
}
