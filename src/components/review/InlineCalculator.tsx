'use client';

import { useId, useState } from 'react';
import { evaluateArithmetic } from '@/lib/calc/evaluate';

/**
 * A one-line calculator under a dose or fluid stem, so the arithmetic does not
 * send the learner to another app mid-question. Collapsed until asked for; the
 * review shortcuts already ignore keys typed into an input, so typing here
 * cannot answer or skip the question.
 */
export function InlineCalculator() {
  const [open, setOpen] = useState(false);
  const [expression, setExpression] = useState('');
  const inputId = useId();
  const value = evaluateArithmetic(expression);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-4 text-sm text-[var(--md-primary)] hover:underline"
      >
        Calculator
      </button>
    );
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
      <label htmlFor={inputId} className="sr-only">Calculation</label>
      <input
        id={inputId}
        type="text"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        value={expression}
        onChange={(event) => setExpression(event.target.value)}
        placeholder="e.g. (1000 + 500 + 16*20) / 24"
        className="min-w-0 flex-1 rounded-md border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-lowest)] px-2 py-1 font-mono text-[var(--md-on-surface)]"
      />
      <output htmlFor={inputId} aria-live="polite" className="font-mono text-[var(--md-on-surface)]">
        {value === null ? (expression.trim() ? '…' : '') : `= ${Number(value.toFixed(2))}`}
      </output>
      <button
        type="button"
        onClick={() => { setOpen(false); setExpression(''); }}
        className="text-[var(--md-on-surface-variant)] hover:text-[var(--md-primary)]"
      >
        Close
      </button>
    </div>
  );
}
