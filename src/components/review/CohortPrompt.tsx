'use client';

import { useEffect, useRef, useState } from 'react';
import {
  isCohortDemandTopic,
  type CohortDemandTopic,
} from '@/lib/cohort/feed-profile';
import {
  COHORT_EXPERIENCE_OPTIONS,
  type CohortExperience,
} from '@/lib/cohort/experience-prior';

function focusFirstChoice(dialog: HTMLDivElement) {
  (dialog.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? dialog).focus();
}

export function CohortPrompt({
  mode,
  demandTopics,
  onExperience,
  onDemand,
  onDismissDemand,
  experienceDisabled = false,
}: {
  mode: 'experience' | 'demand';
  demandTopics: ReadonlyArray<{ id: string; label: string }>;
  onExperience: (experience: CohortExperience) => void;
  onDemand: (input: { topics: CohortDemandTopic[] }) => void;
  onDismissDemand: () => void;
  experienceDisabled?: boolean;
}) {
  const [topics, setTopics] = useState<CohortDemandTopic[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const safeDemandTopics = demandTopics.filter(
    (topic, index, all): topic is { id: CohortDemandTopic; label: string } =>
      isCohortDemandTopic(topic.id)
      && all.findIndex((candidate) => candidate.id === topic.id) === index,
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement;
    focusFirstChoice(dialog);

    const trapTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      // Read the current controls: Save and the experience choices can change
      // their disabled state while this same dialog remains mounted.
      const choices = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const first = choices[0];
      const last = choices.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (!dialog.contains(document.activeElement) || document.activeElement === dialog) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) {
        focusFirstChoice(dialog);
      }
    };
    document.addEventListener('keydown', trapTab, true);
    document.addEventListener('focusin', containFocus);
    return () => {
      document.removeEventListener('keydown', trapTab, true);
      document.removeEventListener('focusin', containFocus);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const active = document.activeElement;
    if (active === dialog || !dialog.contains(active) || active?.matches(':disabled')) {
      focusFirstChoice(dialog);
    }
  }, [mode, experienceDisabled]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="cohort-prompt-title"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-sm overflow-y-auto overscroll-contain rounded-xl bg-[var(--md-surface)] p-5 text-[var(--md-on-surface)] shadow-lg"
      >
        {mode === 'experience' ? (
          <>
            <h2 id="cohort-prompt-title" className="text-base font-semibold">
              Where are you in your USMLE preparation?
            </h2>
            <p className="mt-1 text-sm text-[var(--md-on-surface-variant)]">
              Choose the level that fits your current study.
            </p>
            <div className="mt-4 grid gap-2">
              {COHORT_EXPERIENCE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  disabled={experienceDisabled}
                  onClick={() => onExperience(option.id)}
                  className="rounded-lg border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-high)] px-3 py-2.5 text-left text-sm hover:border-[var(--md-primary)] disabled:cursor-wait disabled:opacity-50"
                >
                  {option.label}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <h2 id="cohort-prompt-title" className="text-base font-semibold">
              Which Step 1 topics would you like to practise?
            </h2>
            <p className="mt-1 text-sm text-[var(--md-on-surface-variant)]">
              Choose areas you want to strengthen for the exam.
            </p>
            {safeDemandTopics.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {safeDemandTopics.map((topic) => {
                  const selected = topics.includes(topic.id);
                  return (
                    <button
                      key={topic.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        setTopics((current) =>
                          selected
                            ? current.filter((id) => id !== topic.id)
                            : [...current, topic.id],
                        );
                      }}
                      className={`rounded-full px-2.5 py-1 text-xs ${
                        selected
                          ? 'bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)]'
                          : 'bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)]'
                      }`}
                    >
                      {topic.label}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onDismissDemand}
                className="rounded-lg px-3 py-1.5 text-sm text-[var(--md-on-surface-variant)]"
              >
                Not now
              </button>
              <button
                type="button"
                disabled={topics.length === 0}
                onClick={() => onDemand({ topics })}
                className="rounded-lg bg-[var(--md-primary)] px-3 py-1.5 text-sm text-[var(--md-on-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
