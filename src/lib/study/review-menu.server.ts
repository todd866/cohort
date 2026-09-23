import 'server-only';

import {
  isPersonalRotation,
  viewerCanAccessPersonalRotation,
  type PersonalRotationViewer,
} from '@/lib/personal-rotation-access';
import { ROTATION_LABELS, rotationLabel } from '@/lib/rotation-labels';
import { getActiveRotations, type TrackNumber } from '@/lib/rotation-context';
import { orderFocusOptions } from '@/lib/study/focus-option-order';
import { inPlayStudyRotations } from '@/lib/study/in-play-rotations';
import { USMLE_STEP1_OPEN_ROTATION } from '@/lib/usmle/raw-question-boundary';
import { reviewMenuRotations, type ReviewMenuChoice } from '@/lib/study/review-menu';

export interface ReviewMenuViewer {
  email: string | null;
  imageTier: string | null | undefined;
  activeModules: readonly string[];
  track: number | null;
  /** False means the shared default. True means reviewMenuModules is the shortlist. */
  reviewMenuCustomized: boolean;
  reviewMenuModules: readonly string[];
}

function viewerOf(user: ReviewMenuViewer): PersonalRotationViewer {
  return {
    emails: [user.email],
    imageTier: user.imageTier ?? null,
  };
}

export function calendarRotation(track: number | null): string | null {
  if (!Number.isInteger(track) || track == null || track < 1 || track > 4) return null;
  return getActiveRotations(track as TrackNumber)[0] ?? null;
}

/** Studyable rotations this viewer may open. Personal decks stay owner-gated. */
export function authorizedStudyRotations(user: ReviewMenuViewer): string[] {
  const viewer = viewerOf(user);
  const enrolled = inPlayStudyRotations([...user.activeModules]);
  const rotations = Object.keys(ROTATION_LABELS).filter((rotation) => {
    if (rotation === 'usmle-step1') return false;
    if (isPersonalRotation(rotation)) {
      return viewerCanAccessPersonalRotation(rotation, viewer);
    }
    if (rotation === USMLE_STEP1_OPEN_ROTATION) return true;
    return user.imageTier === 'copyright' || enrolled.includes(rotation);
  });
  return rotations;
}

export function buildReviewMenu(user: ReviewMenuViewer): {
  menu: string[];
  choices: ReviewMenuChoice[];
} {
  const calendar = calendarRotation(user.track);
  const authorized = authorizedStudyRotations(user);
  const menu = reviewMenuRotations({
    authorized,
    calendarRotation: calendar,
    saved: user.reviewMenuCustomized ? user.reviewMenuModules : null,
  });
  const catalog = orderFocusOptions(
    calendar ? [...authorized, calendar] : authorized,
  );
  const selected = new Set(menu);
  const choices = catalog.map((slug) => ({
    slug,
    label: rotationLabel(slug),
    pinned: slug === calendar,
    checked: selected.has(slug),
  }));
  return { menu, choices };
}
