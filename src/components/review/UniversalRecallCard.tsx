'use client';

import { useState } from 'react';
import { UNIVERSAL_RECALL_SOURCE, type UniversalRecallEvidence, type UniversalRecallObjective } from '@/lib/review/universal-recall';

type Props = {
  objective: UniversalRecallObjective;
  evidence: UniversalRecallEvidence | null;
  onAttempt: (evidence: UniversalRecallEvidence) => void;
  onEvidence: (evidence: UniversalRecallEvidence) => void;
};

export function UniversalRecallCard({ objective, evidence, onAttempt, onEvidence }: Props) {
  const [response, setResponse] = useState('');
  const [assisted, setAssisted] = useState(false);
  const [practice, setPractice] = useState(false);
  const [correction, setCorrection] = useState('');
  const [correctionShown, setCorrectionShown] = useState(false);
  const missed = objective.components.filter(c => evidence?.omittedComponentIds.includes(c.id));
  return <section className="mx-auto w-full max-w-xl space-y-4" aria-label={`${objective.title} recall`}>
    <h2 className="text-xl font-semibold">{objective.prompt}</h2>
    {!evidence ? <>
      <label className="block">Your unaided list
        <textarea className="mt-2 block w-full rounded border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-lowest)] p-3 text-[var(--md-on-surface)]"
          rows={4} maxLength={2000} value={response} onChange={event => setResponse(event.target.value)} />
      </label>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2"><input type="checkbox" checked={assisted}
          onChange={event => setAssisted(event.target.checked)} />Used a cue or reference</label>
        <button type="button" className="rounded border border-[var(--md-outline-variant)] px-4 py-2" onClick={() => onAttempt({
          version: 1, response, assisted, assessment: 'learner-reported',
          omittedComponentIds: objective.components.map(c => c.id),
        })}>{response.trim() ? 'Compare list' : 'I don’t know — show list'}</button>
      </div>
    </> : <>
      <div className="whitespace-pre-wrap rounded border border-[var(--md-outline-variant)] p-3" aria-label="Your locked response">{evidence.response || 'No answer'}</div>
      {!practice || correctionShown ? <>
        <p className="text-sm text-[var(--md-on-surface-variant)]">Mark only categories present in your original answer.</p>
        {objective.components.map(component => <label key={component.id} className="flex min-h-11 items-start gap-3">
          <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" disabled={!evidence.response.trim()}
            checked={!evidence.omittedComponentIds.includes(component.id)} onChange={event => onEvidence({ ...evidence,
              omittedComponentIds: event.target.checked ? evidence.omittedComponentIds.filter(id => id !== component.id)
                : [...evidence.omittedComponentIds, component.id],
            })} />{component.label}
        </label>)}
      </> : <label className="block">Recall the {missed.length} categories you missed
        <textarea rows={3} maxLength={2000} className="mt-2 block w-full rounded border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-lowest)] p-3"
          value={correction} onChange={event => setCorrection(event.target.value)} />
      </label>}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span>{missed.length} omitted · {evidence.assisted ? 'assisted' : 'unaided'} · self-reported</span>
        {missed.length > 0 && !practice && <button type="button" className="rounded border border-[var(--md-outline-variant)] px-3 py-2"
          onClick={() => setPractice(true)}>Practise missed</button>}
        {practice && !correctionShown && <button type="button" className="rounded border border-[var(--md-outline-variant)] px-3 py-2"
          onClick={() => { setCorrectionShown(true); onEvidence({ ...evidence, correctionResponse: correction }); }}>Check correction</button>}
        <a href={UNIVERSAL_RECALL_SOURCE} target="_blank" rel="noreferrer" className="underline">ANZCOR 11.2</a>
      </div>
    </>}
  </section>;
}
