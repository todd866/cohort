'use client';

import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { rotationLabel } from '@/lib/rotation-labels';
import { fetchWithDeadline, CLIENT_FETCH_DEADLINE_MS } from '@/lib/fetch-with-deadline';
import { matchCourseDescription, type CourseMatch } from '@/lib/onboarding/course-match';

// Full names for first-contact users — the short codes (CC, PAAM) mean
// nothing before you know the course.
const FULL_NAMES: Record<string, string> = {
  'critical-care': 'Critical Care',
  paam: 'Psychiatry & Addiction Medicine',
  cah: 'Child & Adolescent Health',
  pwh: 'Perinatal & Women’s Health',
};

interface RotationOnboardingProps {
  /** Scheduled rotation slugs for the user's institution, in calendar order. */
  rotations: string[];
  /** Called after the choice is saved server-side (modules + inferred track). */
  onDone: () => void;
  /** Optional escape hatch — keeps the default feed for "just exploring". */
  onSkip?: () => void;
  /** Set when changing course from the review toolbar rather than onboarding. */
  current?: string;
  /** Renders optional signed-in help without pulling private tutor code into the FOSS boundary. */
  renderHelp?: (props: RotationOnboardingHelpProps) => ReactNode;
}

export interface RotationOnboardingHelpProps {
  visible: boolean;
  initialDraft: string;
  onClose: () => void;
  anchorRef: RefObject<HTMLButtonElement | null>;
  focusRequest: number;
}

/**
 * One-time rotation chooser for anyone — signed in OR a guest — with NO
 * studyable rotations. Before this existed, a new signup was silently dropped
 * onto scheduledRotations[0] with no way to pick their stream on mobile, and
 * real first sessions served the wrong rotation end to end (2026-08-18/19).
 *
 * Guests were added 2026-08-23: they were still being dropped on the CAH
 * acquisition default, so a guest could study the wrong rotation for a whole
 * first session before registering. Saving posts to /api/user/rotation, which
 * accepts a guest, syncs activeModules and infers the track so later block
 * changes auto-advance. The guest's answer is carried onto their account by
 * claimGuestProgressRecords, so the question is never asked twice.
 */
export function RotationOnboarding({ rotations, onDone, onSkip, current, renderHelp }: RotationOnboardingProps) {
  // Changing course from the toolbar chip is not first-visit onboarding: it
  // opens over the review, marks where they are, and cancels (2026-10-01).
  const changing = current !== undefined;
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [describing, setDescribing] = useState(false);
  const [description, setDescription] = useState('');
  const [offer, setOffer] = useState<CourseMatch | null>(null);
  const [aiOpened, setAiOpened] = useState(false);
  const [aiVisible, setAiVisible] = useState(false);
  const aiButton = useRef<HTMLButtonElement>(null);
  const aiDraft = `Help me choose where to start in md3. Ask about my course, exam and date, and what I find difficult. The quick choices here are ${rotations.map(rotation => FULL_NAMES[rotation] ?? rotationLabel(rotation)).join(', ')}. Recommend a suitable choice if one fits; otherwise tell me to use Something else. I will select the rotation myself to start Review.`;


  // Whoever is not on the list still has to land somewhere, so "something else"
  // ends where "skip" ends: the default feed. It must NOT call onDone, which
  // reloads — with no rotation saved the reload would ask the same question
  // again, which is what the free-text answer was meant to spare them.
  const leaveWithoutARotation = onSkip ?? onDone;

  // Name the deck they will actually get rather than calling it "the default".
  // Somebody who has just explained that they are a GP registrar deserves to
  // know they are about to be served paediatrics, and to decide for themselves
  // whether that is worth their time today.
  const meanwhileDeck = FULL_NAMES[rotations[0] ?? ''] ?? 'the default deck';

  /**
   * Their answer is a support message, not a setting.
   *
   * /api/user/curriculum-request files it in the human moderation queue under
   * `onboarding-other`, where the morning check turns it into an actual feed,
   * and stamps the user so this question is never asked of them again. Three
   * things follow and none is incidental: no rotation is written, because
   * guessing one is exactly the bug the chooser exists to prevent; the prose is
   * untrusted and stays quarantined behind that queue's review boundary; and a
   * failed send never strands the learner on a form.
   */
  const sendDescription = async () => {
    const message = description.trim();
    if (!message || saving) return;
    setSaving('other');
    try {
      await fetchWithDeadline('/api/user/curriculum-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: message }),
      }, CLIENT_FETCH_DEADLINE_MS);
    } catch {
      // Deliberately swallowed: see above.
    }
    // A description naming one rotation md3 teaches gets that rotation offered,
    // started only by their tap; anything else keeps the default (24 Oct 2026).
    const match = matchCourseDescription(message, rotations);
    if (match) {
      setOffer(match);
      setSaving(null);
      return;
    }
    leaveWithoutARotation();
  };

  const pick = async (rotation: string) => {
    if (saving) return;
    setSaving(rotation);
    setError(null);
    try {
      const res = await fetchWithDeadline('/api/user/rotation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rotation }),
      }, CLIENT_FETCH_DEADLINE_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onDone();
    } catch {
      setError('Could not save your choice — check your connection and tap again.');
      setSaving(null);
    }
  };

  return (
    <div className={!changing && aiVisible ? 'md:pr-[min(30rem,42vw)]' : undefined}>
    <div className={changing ? 'w-full' : 'mx-auto w-full max-w-md px-4 py-10'}>
      {changing ? (
        <h2 className="text-lg font-semibold text-[var(--md-on-surface)]">Change rotation</h2>
      ) : (
        <>
          <h1 className="text-xl font-semibold text-[var(--md-on-surface)]">
            What are you studying right now?
          </h1>
          <p className="mt-2 text-sm text-[var(--md-on-surface-variant)]">
            Pick your current rotation and we&rsquo;ll build your queue from it.
            You can change this any time.
          </p>
        </>
      )}
      <div className="mt-6 flex flex-col gap-3">
        {rotations.map((rotation) => (
          <button
            key={rotation}
            type="button"
            disabled={saving !== null}
            aria-current={rotation === current ? 'true' : undefined}
            onClick={() => (rotation === current && onSkip ? onSkip() : void pick(rotation))}
            className={`w-full rounded-xl border px-4 py-3.5 text-left text-base font-medium text-[var(--md-on-surface)] transition-colors hover:bg-[var(--md-surface-container-high)] disabled:opacity-60 ${rotation === current ? 'border-[var(--md-primary)] bg-[var(--md-primary-container)]' : 'border-[var(--md-outline-variant)] bg-[var(--md-surface-container)]'}`}
          >
            {rotation === current && <span aria-hidden className="mr-2">✓</span>}
            {FULL_NAMES[rotation] ?? rotationLabel(rotation)}
            <span className="ml-2 text-sm text-[var(--md-on-surface-variant)]">
              {rotationLabel(rotation)}
            </span>
            {saving === rotation ? '…' : ''}
          </button>
        ))}
      </div>
      {!changing && renderHelp && (
        <button ref={aiButton} type="button" disabled={saving !== null}
          onClick={() => { setAiOpened(true); setAiVisible(true); }}
          className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-[var(--md-primary)] hover:underline disabled:opacity-60">
          Help me choose
        </button>
      )}
      {!changing && renderHelp && aiOpened && renderHelp({
        visible: aiVisible,
        initialDraft: aiDraft,
        focusRequest: aiVisible ? 1 : 0,
        anchorRef: aiButton,
        onClose: () => { setAiVisible(false); aiButton.current?.focus(); },
      })}
      {!describing && (
        <button
          type="button"
          disabled={saving !== null}
          onClick={() => setDescribing(true)}
          className="mt-3 w-full rounded-xl border border-dashed border-[var(--md-outline-variant)] px-4 py-3.5 text-left text-base font-medium text-[var(--md-on-surface-variant)] transition-colors hover:bg-[var(--md-surface-container)] disabled:opacity-60"
        >
          Something else
          <span className="ml-2 text-sm">
            another university, rotation or job
          </span>
        </button>
      )}
      {offer && (
        <div className="mt-4">
          <div className="flex gap-2">
            {offer.kind === 'rotation' ? (
              <button
                type="button"
                disabled={saving !== null}
                onClick={() => void pick(offer.rotation)}
                aria-label={`Start ${FULL_NAMES[offer.rotation] ?? rotationLabel(offer.rotation)}`}
                className="flex-1 rounded-xl bg-[var(--md-primary)] px-4 py-3.5 text-left text-base font-medium text-[var(--md-on-primary)] transition-opacity disabled:opacity-60"
              >
                Start {rotationLabel(offer.rotation)}{saving === offer.rotation ? '…' : ''}
              </button>
            ) : (
              <a
                href="https://cohort.md"
                className="flex-1 rounded-xl bg-[var(--md-primary)] px-4 py-3.5 text-base font-medium text-[var(--md-on-primary)]"
              >
                Open USMLE Step 1 on cohort.md
              </a>
            )}
            <button
              type="button"
              disabled={saving !== null}
              onClick={leaveWithoutARotation}
              className="rounded-xl border border-[var(--md-outline-variant)] px-4 py-3.5 text-base font-medium text-[var(--md-on-surface-variant)] disabled:opacity-60"
            >
              Not now
            </button>
          </div>
          <p className="mt-2 text-sm text-[var(--md-on-surface-variant)]">
            The closest match to your course. A person reads your note and can fit it better.
          </p>
        </div>
      )}
      {describing && !offer && (
        <div className="mt-4">
          <label
            htmlFor="onboarding-other"
            className="block text-sm text-[var(--md-on-surface)]"
          >
            Tell us as much as you can about what you&rsquo;re trying to learn —
            the exam and its date, and the university, rotation or job it is for.
          </label>
          <textarea
            id="onboarding-other"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={5}
            maxLength={5000}
            placeholder="e.g. GP registrar sitting the RACGP KFP on 12 November; trained at Otago, working in rural ED."
            className="mt-2 w-full rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] px-4 py-3 text-base text-[var(--md-on-surface)] placeholder:text-[var(--md-on-surface-variant)]"
          />
          <button
            type="button"
            disabled={saving !== null || description.trim().length === 0}
            onClick={() => void sendDescription()}
            className="mt-3 w-full rounded-xl bg-[var(--md-primary)] px-4 py-3.5 text-base font-medium text-[var(--md-on-primary)] transition-opacity disabled:opacity-60"
          >
            Send and start studying
          </button>
          <p className="mt-2 text-sm text-[var(--md-on-surface-variant)]">
            A person reads these, usually within a day. Until your feed is set
            up you&rsquo;ll study {meanwhileDeck}, and you won&rsquo;t be asked
            this again.
          </p>
        </div>
      )}
      {error && (
        <p className="mt-4 text-sm text-[var(--md-error)]" role="alert">
          {error}
        </p>
      )}
      {onSkip && (
        <button
          type="button"
          onClick={onSkip}
          className="mt-6 w-full text-center text-sm text-[var(--md-on-surface-variant)] underline-offset-2 hover:underline"
        >
          {changing ? 'Cancel' : 'Skip for now'}
        </button>
      )}
    </div>
    </div>
  );
}
