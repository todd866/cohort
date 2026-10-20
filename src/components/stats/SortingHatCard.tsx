'use client';

import { useEffect, useRef, useState } from 'react';
import { HAT_CASES, sortHatChoice, type SortingHatState } from '@/lib/stats/sorting-hat';
import { CLIENT_FETCH_DEADLINE_MS, fetchWithDeadline } from '@/lib/fetch-with-deadline';

const choiceClass = 'min-h-11 rounded-lg border border-[var(--md-outline-variant)] px-3 py-2 text-left text-sm text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--md-primary)]';
const actionClass = 'min-h-11 px-2 text-sm font-medium text-[var(--md-primary)] underline disabled:opacity-50';

/** Same confirmed learning goal and prompt ledger as Review; guesses stay local. */
export function SortingHatCard({ initialState }: {initialState: SortingHatState}) {
  const [confirmed, setConfirmed] = useState(initialState.confirmed);
  const [claimId, setClaimId] = useState(initialState.claimId);
  const [choosing, setChoosing] = useState(false);
  const [caseId, setCaseId] = useState<string|null>(null);
  const [challenged, setChallenged] = useState(false);
  const [message, setMessage] = useState<string|null>(null);
  const [error, setError] = useState<string|null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController|null>(null);
  useEffect(() => () => { pending.current?.abort(); }, []);
  const reading = sortHatChoice(caseId, confirmed?.choice);

  async function write(body: Record<string,unknown>) {
    const controller = new AbortController();
    pending.current = controller;
    const response = await fetchWithDeadline('/api/user/check-in', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body), signal:controller.signal,
    }, CLIENT_FETCH_DEADLINE_MS);
    if (!response.ok) throw new Error('Could not confirm the change. Please try again.');
    const data = await response.json() as {question?:{claimId:string}|null};
    if (controller.signal.aborted) throw new DOMException('Aborted','AbortError');
    return data;
  }

  async function start() {
    if (busy) return;
    setError(null); setMessage(null); setCaseId(null); setChallenged(false);
    // Editing an already answered question does not manufacture a new prompt.
    if (confirmed && claimId) { setChoosing(true); return; }
    setBusy(true);
    try {
      const body = await write({action:'claim',surface:'sorting-hat',timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});
      if (body.question) { setClaimId(body.question.claimId); setChoosing(true); }
      else setMessage('The hat needs a breather. Come back later.');
    } catch {
      if (!pending.current?.signal.aborted) setError('Could not open the hat. Please try again.');
    } finally { if (!pending.current?.signal.aborted) setBusy(false); }
  }

  async function save(action: 'answer'|'skip'|'clear-answer') {
    if (!claimId || busy || (action === 'answer' && !reading)) return;
    setBusy(true); setError(null);
    try {
      await write({action,claimId,...(action === 'answer' ? {choice:reading!.choice} : {})});
      if (action === 'answer') setConfirmed({choice:reading!.choice,label:reading!.label});
      if (action === 'clear-answer') { setConfirmed(null); setClaimId(null); }
      if (action === 'skip' && !confirmed) setClaimId(null);
      setChoosing(false); setCaseId(null);
      setMessage(action === 'clear-answer' ? 'Forgotten. A clean slate for the hat.' : action === 'skip' ? 'The hat can wait.' : null);
    } catch {
      if (!pending.current?.signal.aborted) setError('Could not confirm the change. Please try again.');
    } finally { if (!pending.current?.signal.aborted) setBusy(false); }
  }

  return (
    <details className="mb-2 border-b border-[var(--md-outline-soft)] text-sm">
      <summary className="min-h-11 cursor-pointer py-3 font-medium text-[var(--md-on-surface)]">🎩 Sorting Hat</summary>
      <div className="pb-3">
        {!choosing ? <>
          {confirmed ? <>
            <p className="font-medium text-[var(--md-on-surface)]">{confirmed.label} won that round.</p>
            <p className="mt-2 text-[var(--md-on-surface-variant)]">I’ll use your pick in MD3’s study suggestions.</p>
            <div className="mt-1 flex flex-wrap gap-x-3">
              <button type="button" className={actionClass} disabled={busy} onClick={()=>void start()}>Change my pick</button>
              {claimId && <button type="button" className={actionClass} disabled={busy} onClick={()=>void save('clear-answer')}>Forget this</button>}
            </div>
          </> : <>
            <p className="text-[var(--md-on-surface-variant)]">Let me try a hunch. Tell me when I’m onto something; I’ll remember it for MD3’s study suggestions.</p>
            <button type="button" className={actionClass} disabled={busy} onClick={()=>void start()}>{busy ? 'One moment…' : 'Try the hat'}</button>
          </>}
        </> : reading ? <>
          <p className="my-2 text-base font-medium leading-relaxed text-[var(--md-on-surface)]">{reading.guess}</p>
          <details className="text-[var(--md-on-surface-variant)]">
            <summary className="min-h-11 cursor-pointer py-3">Why this?</summary>
            <p>{reading.evidence}</p>
          </details>
          <div className="flex flex-wrap gap-x-3">
            <button type="button" className={actionClass} disabled={busy} onClick={()=>void save('answer')}>{busy ? 'One moment…' : 'More like this'}</button>
            <button type="button" className={actionClass} disabled={busy} onClick={()=>{setCaseId(null);setChallenged(true);}}>Not quite</button>
            <button type="button" className={actionClass} disabled={busy} onClick={()=>void save('skip')}>Pass</button>
          </div>
        </> : <>
          {challenged && <p className="mb-2 text-[var(--md-on-surface-variant)]">Fair. Even enchanted hats miss. What caught your eye instead?</p>}
          <fieldset disabled={busy}>
            <legend className="mb-3 font-medium text-[var(--md-on-surface)]">Which case would you stay for?</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {HAT_CASES.map(choice=><button type="button" key={choice.id} className={choiceClass} onClick={()=>setCaseId(choice.id)}>{choice.label}</button>)}
            </div>
          </fieldset>
          <button type="button" className={actionClass} disabled={busy} onClick={()=>void save('skip')}>Pass</button>
        </>}
        {message && <p role="status" className="py-2 text-[var(--md-on-surface-variant)]">{message}</p>}
        {error && <p role="alert" className="py-2 text-[var(--md-error)]">{error}</p>}
      </div>
    </details>
  );
}
