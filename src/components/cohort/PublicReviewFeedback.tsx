'use client';
import { ThumbIcon } from '@/components/shared/ThumbIcon';
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { genClientRequestId } from '@/lib/client-request-id';
import { fetchWithDeadline, CLIENT_FETCH_DEADLINE_MS } from '@/lib/fetch-with-deadline';

/** Feedback is addressed only to the owned delivery currently on screen. */
export function PublicReviewFeedback({deliveryId, open, onOpenChange, allowRatings = true, apiRef}: {deliveryId: string; apiRef?: Ref<{rate:(rating:'good'|'bad')=>void}>; allowRatings?: boolean; open: boolean; onOpenChange: (open: boolean) => void}) {
  const [rating, setRating] = useState<string|null>(null);
  const [reason, setReason] = useState('Other');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const pending = useRef<Record<string, unknown> | null>(null);
  const busy = useRef(false);
  async function submit(kind: 'flag' | 'rating', rating?: string) {
    if (busy.current) return;
    busy.current = true;
    setStatus('saving');
    const body = pending.current ?? {deliveryId, clientRequestId: genClientRequestId(), kind, ...(kind === 'flag' ? {reason, message} : {rating})};
    pending.current = body;
    try {
      const response = await fetchWithDeadline('/api/cohort/feedback', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}, CLIENT_FETCH_DEADLINE_MS);
      if (!response.ok) throw new Error('Could not save feedback');
      pending.current = null;
      if(body.kind === 'rating') setRating(body.rating === 'clear' ? null : String(body.rating));
      setStatus('saved');
      onOpenChange(false);
    } catch { setStatus('error'); }
    finally { busy.current = false; }
  }
  const rate = (next: 'good'|'bad') => { if(allowRatings) void submit('rating',rating===next?'clear':next); };
  useImperativeHandle(apiRef,()=>({rate}));
  return <div className="mt-5 text-sm text-[var(--md-on-surface-variant)]">
    <div className="flex items-center gap-3">
      {allowRatings && <><button type="button" aria-label="Good content" disabled={status === 'saving' || status === 'error'} aria-pressed={rating==='good'} onClick={() => rate('good')} className="min-h-11 px-2"><ThumbIcon direction="up" className="h-4 w-4"/></button>
      <button type="button" aria-label="Bad content" disabled={status === 'saving' || status === 'error'} aria-pressed={rating==='bad'} onClick={() => rate('bad')} className="min-h-11 px-2"><ThumbIcon direction="down" className="h-4 w-4"/></button></>}

      {status === 'saved' && <span role="status">Feedback saved</span>}
    </div>
    {open && <form onSubmit={event => {event.preventDefault(); void submit('flag');}} className="mt-2 space-y-3">
      <label className="block">Issue<select aria-label="Issue" value={reason} disabled={status === 'saving' || status === 'error'} onChange={event => setReason(event.target.value)} className="ml-2 rounded border bg-[var(--md-surface)] p-2">{['Context','Formatting','Needs Image','Giveaway','Rewrite','Length Bias','Acronym','Too Long','Other'].map(value => <option key={value}>{value}</option>)}</select></label>
      <textarea aria-label="Feedback details" maxLength={1000} value={message} disabled={status === 'saving' || status === 'error'} onChange={event => setMessage(event.target.value)} className="block min-h-24 w-full rounded border border-[var(--md-outline-variant)] bg-[var(--md-surface)] p-3" />
      <button disabled={status === 'saving' || status === 'error'} className="min-h-11 rounded border px-4">{status === 'saving' ? 'Saving…' : 'Send feedback'}</button>
    </form>}
    {status === 'error' && <p role="alert">Feedback could not be saved. <button className="min-h-11 underline" onClick={() => void submit('flag')}>Retry</button></p>}
  </div>;
}
