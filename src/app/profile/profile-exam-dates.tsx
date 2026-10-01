'use client';

import { useState } from 'react';

interface RotationRow {
  id: string;
  shortName: string;
  examDate: string;
}

interface Props {
  rotations: Array<RotationRow>;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function ExamDatesEditor({ rotations }: Props) {
  const [dates, setDates] = useState<Record<string, string>>(
    Object.fromEntries(rotations.map((r) => [r.id, r.examDate])),
  );
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({});

  const handleChange = async (rotationId: string, value: string) => {
    setDates((prev) => ({ ...prev, [rotationId]: value }));
    setSaveState((prev) => ({ ...prev, [rotationId]: 'saving' }));

    try {
      const res = await fetch('/api/user', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ examDates: { [rotationId]: value } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSaveState((prev) => ({ ...prev, [rotationId]: 'saved' }));
      setTimeout(() => {
        setSaveState((prev) => {
          if (prev[rotationId] !== 'saved') return prev;
          const next = { ...prev };
          delete next[rotationId];
          return next;
        });
      }, 1500);
    } catch {
      setSaveState((prev) => ({ ...prev, [rotationId]: 'error' }));
    }
  };

  return (
    <div>
      <h3 className="text-sm font-semibold mb-2 text-[var(--md-on-surface)]">Exam dates</h3>
      <div className="space-y-2">
        {rotations.map((r) => {
          const state = saveState[r.id];
          return (
            <div key={r.id} className="flex items-center gap-3">
              <span className="w-16 text-sm text-[var(--md-on-surface)]">{r.shortName}</span>
              <input
                type="date"
                value={dates[r.id] ?? ''}
                onChange={(e) => handleChange(r.id, e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg bg-[var(--md-surface)] border border-[var(--md-outline-variant)] text-sm text-[var(--md-on-surface)]"
              />
              <span className="w-16 text-right text-xs text-[var(--md-on-surface-variant)]" aria-live="polite">
                {state === 'saving' && 'Saving…'}
                {state === 'saved' && 'Saved'}
                {state === 'error' && 'Error'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
