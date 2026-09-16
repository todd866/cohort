'use client';

import type { RefObject } from 'react';
import type {
  ClinicalExam,
  ExamAlgorithm,
  ExamChecklist,
  ExamStep,
} from '@/lib/clinical-exams';
import { allExamSteps } from '@/lib/clinical-exams';

/**
 * Drill layer over the bedside protocol — born from a failed paediatric BLS
 * WBA. Two registers, one page:
 *
 *   - the FACE is the recitable patter (`exam.drill` up top, `step.script`
 *     per step): short imperative lines you memorise and speak;
 *   - the DEPTH is on demand (`step.expand`): which adjunct / how to fit it /
 *     what if it doesn't work — opened per step, or all at once when an
 *     assessor is quizzing mid-drill.
 *
 * All fields are optional extensions of the existing schema; an exam without
 * them renders exactly as before. Disclosure is native <details>/<summary>
 * (zero JS per step); "expand all" is one imperative pass over the details
 * elements, which keeps per-step toggling free and print/reading mode sane.
 */

export interface StepExpand {
  title: string;
  /** When / which-one choice logic. */
  decision?: string[];
  /** How-to. */
  technique?: string[];
  /** Failure branches. */
  whatIf?: { q: string; a: string }[];
}

/** ExamStep with the optional drill-layer fields. Plain ExamStep satisfies it. */
export type DrillStep = ExamStep & {
  /** The terse recitable line — the step's face when present. */
  script?: string;
  expand?: StepExpand;
};

/** ClinicalExam with the optional front-page patter block. */
export type DrillExam = ClinicalExam & {
  drill?: string[];
};

/**
 * Code-native version of the strong Canvas algorithm pattern: one vertical
 * route, a terse recall anchor, action-first boxes, and only the numbers that
 * change what the learner does. It is reusable for any ordered protocol and
 * stays legible on a phone or a printed page.
 */
export function AlgorithmCard({ algorithm }: { algorithm: ExamAlgorithm }) {
  return (
    <section
      aria-label={`${algorithm.title} compact algorithm`}
      className="mt-5 overflow-hidden rounded-xl border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-lowest)] shadow-[var(--md-shadow-1)]"
    >
      <header className="border-b border-[var(--md-outline-soft)] bg-[var(--md-surface-container)] px-4 py-3.5">
        <p className="text-[0.68rem] font-bold uppercase tracking-[0.14em] text-[var(--md-primary)]">
          Compact algorithm
        </p>
        <h2 className="mt-1 text-lg font-bold tracking-tight text-[var(--md-on-surface)]">
          {algorithm.title}
        </h2>
        {algorithm.subtitle ? (
          <p className="mt-1 text-xs leading-relaxed text-[var(--md-on-surface-variant)]">
            {algorithm.subtitle}
          </p>
        ) : null}
      </header>

      <ol className="px-3 py-4 sm:px-4">
        {algorithm.steps.map((step, index) => (
          <li key={`${index}-${step.key}-${step.action}`} className="relative flex gap-3 pb-5 last:pb-0">
            {index < algorithm.steps.length - 1 ? (
              <span
                aria-hidden
                className="absolute bottom-0 left-[1.18rem] top-10 w-0.5 bg-[var(--md-outline-soft)]"
              />
            ) : null}
            <span className="relative z-10 flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--md-primary)] text-lg font-black text-[var(--md-on-primary)]">
              {step.key}
            </span>
            <div className="min-w-0 flex-1 rounded-xl border-2 border-[var(--md-outline)] bg-[var(--md-surface-container-lowest)] px-3.5 py-3">
              <p className="font-bold leading-snug text-[var(--md-on-surface)]">{step.action}</p>
              {step.detail ? (
                <p className="mt-1 text-sm leading-relaxed text-[var(--md-on-surface-variant)]">
                  {step.detail}
                </p>
              ) : null}
              {step.callout ? (
                <p className="mt-2 rounded-lg bg-[var(--md-primary-container)] px-3 py-2 text-sm font-bold leading-snug text-[var(--md-on-primary-container)]">
                  {step.callout}
                </p>
              ) : null}
              {step.metrics && step.metrics.length > 0 ? (
                <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                  {step.metrics.map((metric) => (
                    <li
                      key={metric}
                      className="rounded-lg bg-[var(--md-surface-container)] px-3 py-2 text-xs font-semibold leading-snug text-[var(--md-on-surface)]"
                    >
                      {metric}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function examHasExpandableSteps(exam: ClinicalExam): boolean {
  return allExamSteps(exam).some((step: DrillStep) => step.expand !== undefined);
}

/**
 * The front-page patter: the whole drill as one terse, print-clean block.
 * This is the primary artifact — what gets recited, not read.
 */
export function DrillCard({ lines }: { lines: string[] }) {
  const items = lines.map((raw) => {
    const indented = /^\s/.test(raw);
    const trimmed = raw.trim();
    const keyed = trimmed.match(/^([A-Z]|►|⟳)\s{2,}(.+)$/);
    const body = keyed?.[2] ?? trimmed;
    const dashAt = body.indexOf(' — ');
    return {
      key: keyed?.[1] ?? (indented ? '↳' : undefined),
      action: dashAt >= 0 ? body.slice(0, dashAt) : body,
      detail: dashAt >= 0 ? body.slice(dashAt + 3) : undefined,
    };
  });

  return (
    <ChecklistCard
      checklist={{
        title: 'The drill',
        subtitle: 'Recite one clean pass. Open the detail below only when you need it.',
        items,
      }}
    />
  );
}

export function ChecklistCard({ checklist }: { checklist: ExamChecklist }) {
  return (
    <section
      aria-label={`${checklist.title} compact checklist`}
      className="mt-5 overflow-hidden rounded-xl border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-lowest)] shadow-[var(--md-shadow-1)]"
    >
      <header className="border-b border-[var(--md-outline-soft)] bg-[var(--md-surface-container)] px-4 py-3.5">
        <p className="text-[0.68rem] font-bold uppercase tracking-[0.14em] text-[var(--md-primary)]">
          Compact checklist
        </p>
        <h2 className="mt-1 text-lg font-bold tracking-tight text-[var(--md-on-surface)]">
          {checklist.title}
        </h2>
        {checklist.subtitle ? (
          <p className="mt-1 text-xs leading-relaxed text-[var(--md-on-surface-variant)]">
            {checklist.subtitle}
          </p>
        ) : null}
      </header>
      <ol className="px-3 py-4 sm:px-4">
        {checklist.items.map((item, index) => (
          <li key={`${index}-${item.key ?? ''}-${item.action}`} className="relative flex gap-3 pb-3 last:pb-0">
            {index < checklist.items.length - 1 ? (
              <span
                aria-hidden
                className="absolute bottom-0 left-4 top-8 w-px bg-[var(--md-outline-soft)]"
              />
            ) : null}
            <span className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--md-primary-container)] text-xs font-black text-[var(--md-on-primary-container)]">
              {item.key ?? index + 1}
            </span>
            <p className="min-w-0 flex-1 rounded-lg border border-[var(--md-outline-soft)] px-3 py-2 text-sm leading-snug text-[var(--md-on-surface)]">
              <strong>{item.action}</strong>
              {item.detail ? <span> — {item.detail}</span> : null}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Expand/collapse-all over every <details> under `rootRef`. Imperative on
 * purpose: the disclosures stay native and uncontrolled, so tapping one step
 * costs no JS and no re-render.
 */
export function ExpandAllControls({
  rootRef,
}: {
  rootRef: RefObject<HTMLElement | null>;
}) {
  const setAll = (open: boolean) => {
    rootRef.current?.querySelectorAll('details').forEach((d) => {
      d.open = open;
    });
  };
  const buttonClass =
    'min-h-9 rounded border border-[var(--md-outline-soft)] px-2.5 py-1 text-xs font-semibold text-[var(--md-on-surface-variant)] transition-colors hover:bg-[var(--md-surface-container)]';
  return (
    <div className="mt-6 flex justify-end gap-2 print:hidden">
      <button type="button" onClick={() => setAll(true)} className={buttonClass}>
        Expand all
      </button>
      <button type="button" onClick={() => setAll(false)} className={buttonClass}>
        Collapse all
      </button>
    </div>
  );
}

/** The step's face: script (bold, terse) demotes the full text; else legacy markup. */
function StepFace({ step }: { step: DrillStep }) {
  if (step.script) {
    return (
      <>
        <p className="text-[1.02rem] leading-snug font-bold tracking-tight text-[var(--md-on-surface)]">
          {step.script}
        </p>
        <p className="mt-0.5 text-[0.85rem] leading-relaxed text-[var(--md-on-surface-variant)]">
          {step.text}
        </p>
        {step.note && (
          <p className="mt-1 text-[0.85rem] leading-relaxed text-[var(--md-on-surface-variant)]">
            {step.note}
          </p>
        )}
      </>
    );
  }
  return (
    <>
      <p className="text-[1.02rem] leading-snug text-[var(--md-on-surface)]">{step.text}</p>
      {step.note && (
        <p className="mt-1 text-[0.85rem] leading-relaxed text-[var(--md-on-surface-variant)]">
          {step.note}
        </p>
      )}
    </>
  );
}

function ExpandList({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="mt-3 first:mt-2">
      <p className="text-[0.68rem] font-bold uppercase tracking-wider text-[var(--md-on-surface-variant)]">
        {label}
      </p>
      <ul className="mt-1 space-y-1">
        {items.map((item) => (
          <li
            key={item}
            className="flex gap-2 text-sm leading-relaxed text-[var(--md-on-surface)]"
          >
            <span className="text-[var(--md-on-surface-variant)]" aria-hidden>
              ·
            </span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A step's content column. Without `expand`, this is byte-for-byte the legacy
 * markup. With it, the face becomes a native disclosure over the decision /
 * technique / what-if depth.
 */
export function StepBody({ step }: { step: DrillStep }) {
  const expand = step.expand;
  if (!expand) return <StepFace step={step} />;

  return (
    <details className="group">
      <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <StepFace step={step} />
          </div>
          <span
            aria-hidden
            className="mt-1 shrink-0 text-xs text-[var(--md-on-surface-variant)] transition-transform group-open:rotate-90"
          >
            ▸
          </span>
        </div>
      </summary>
      <div className="mt-2 rounded-lg border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)] px-3 pb-3 pt-2.5">
        <p className="text-[0.7rem] font-bold uppercase tracking-[0.14em] text-[var(--md-primary)]">
          {expand.title}
        </p>
        {expand.decision && expand.decision.length > 0 && (
          <ExpandList label="Which / when" items={expand.decision} />
        )}
        {expand.technique && expand.technique.length > 0 && (
          <ExpandList label="How" items={expand.technique} />
        )}
        {expand.whatIf && expand.whatIf.length > 0 && (
          <div className="mt-3 first:mt-2">
            <p className="text-[0.68rem] font-bold uppercase tracking-wider text-[var(--md-on-surface-variant)]">
              If not…
            </p>
            <dl className="mt-1 space-y-1.5">
              {expand.whatIf.map(({ q, a }) => (
                <div key={q}>
                  <dt className="text-sm font-semibold leading-snug text-[var(--md-on-surface)]">
                    {q}
                  </dt>
                  <dd className="text-sm leading-relaxed text-[var(--md-on-surface-variant)]">
                    {a}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </details>
  );
}
