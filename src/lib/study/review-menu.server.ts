import 'server-only';

import {
  isPersonalRotation,
  viewerCanAccessPersonalRotation,
  type PersonalRotationViewer,
} from '@/lib/personal-rotation-access';
import { ROTATION_LABELS, rotationLabel } from '@/lib/rotation-labels';
import { getCurrentBlockIndex, scheduledRotationPhase, TRACKS, type TrackNumber } from '@/lib/rotation-context';
import { orderFocusOptions } from '@/lib/study/focus-option-order';
import { inPlayStudyRotations } from '@/lib/study/in-play-rotations';
import { USMLE_STEP1_OPEN_ROTATION } from '@/lib/usmle/raw-question-boundary';
import { reviewMenuRotations, type ReviewMenuChoice } from '@/lib/study/review-menu';
import { isMd1Program, MD1_DECK } from '@/lib/md1-program';

export interface ReviewMenuViewer {
  email: string | null;
  imageTier: string | null | undefined;
  activeModules: readonly string[];
  track: number | null;
  /** User.institution. 'usyd-md1' swaps the Year 3 calendar for the first-year default. */
  institution?: string | null;
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

export function calendarRotation(track: number | null, now: Date = new Date()): string | null {
  if (!Number.isInteger(track) || track == null || track < 1 || track > 4) return null;
  return TRACKS[track as TrackNumber][getCurrentBlockIndex(now)] ?? null;
}

const EARLY_YEAR_DECK = /^year[12]-/;

/** First- and second-year decks belong in the menus of MD1 and MD2 learners only. */
function inEarlyYears(institution: string | null | undefined): boolean {
  return institution === 'usyd-md1' || institution === 'usyd-md2';
}

/**
 * Read-time block rollover for a saved menu, 2026-10-22. A shortlist saved
 * during CAH still listed CAH a block later, and first-year KAT decks lingered
 * in Year 3 menus. Stored preferences are not rewritten: the menu drops a
 * rotation the learner's stream has finished, and the catalogue (choices)
 * keeps it listed and unticked, so a past block stays one tap away.
 */
export function relevantMenuSlugs(
  slugs: readonly string[],
  viewer: { track: number | null; institution?: string | null },
  now: Date = new Date(),
): string[] {
  const early = inEarlyYears(viewer.institution);
  return slugs.filter((slug) => (early || !EARLY_YEAR_DECK.test(slug))
    && scheduledRotationPhase(slug, viewer.track, now) !== 'past');
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

export function buildReviewMenu(user: ReviewMenuViewer, now: Date = new Date()): {
  menu: string[];
  choices: ReviewMenuChoice[];
} {
  const md1 = isMd1Program(user.institution);
  // A first-year has no Year 3 block, whatever track the chooser left behind.
  const calendar = md1 ? null : calendarRotation(user.track, now);
  const early = inEarlyYears(user.institution);
  const authorized = authorizedStudyRotations(user).filter((slug) => early || !EARLY_YEAR_DECK.test(slug));
  const alwaysOfferGsse = user.imageTier === 'copyright' && authorized.includes('surgical-sciences');
  const menu = reviewMenuRotations({
    authorized,
    calendarRotation: calendar,
    saved: user.reviewMenuCustomized ? relevantMenuSlugs(user.reviewMenuModules, user, now) : null,
    program: md1 ? 'md1' : null,
  });
  // GSSE is a shared copyright-tier choice, including saved and MD1 menus.
  // This changes visibility only; selecting it still uses the enrollment API.
  if (alwaysOfferGsse && !menu.includes('surgical-sciences')) menu.push('surgical-sciences');
  const orderedMenu = orderFocusOptions(menu);
  const pinned = md1 ? (menu.includes(MD1_DECK) ? MD1_DECK : null) : calendar;
  // The booked block is usually authorized already; listing it twice showed
  // two pinned rows for one block.
  const catalog = orderFocusOptions([
    ...new Set(calendar ? [...authorized, calendar] : authorized),
  ]);
  const selected = new Set(menu);
  const choices = catalog.map((slug) => ({
    slug,
    label: rotationLabel(slug),
    pinned: slug === pinned || (alwaysOfferGsse && slug === 'surgical-sciences'),
    checked: selected.has(slug),
  }));
  return { menu: orderedMenu, choices };
}
