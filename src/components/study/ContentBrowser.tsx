'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSession } from 'next-auth/react';
import { rotationLabel } from '@/lib/rotation-labels';

export interface ContentBrowserFilters {
  type: 'card' | 'question';
  status: 'all' | 'seen' | 'unseen';
  rotation: string;
  cluster: string;
  q: string;
  topic: string;
  source: string;
}
export interface BrowserItem {
  id: string; type: 'card' | 'question'; text: string; topics: string[];
  source: string | null; rotation: string | null; status: 'seen' | 'unseen';
  reviewCount: number; lastReviewedAt: string | null; href: string;
}
interface BrowserPage { items: BrowserItem[]; nextCursor: string | null }
interface BrowserDetail {
  item: BrowserItem;
  preview: { front?: string; back?: string; context?: string | null; stem?: string; options?: unknown };
  history: Array<{id: string; at: string; rating: string}>;
  historyHasMore: boolean; historyNote: string;
}
export const browserControl = 'min-h-11 min-w-0 rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface)] px-3 py-2 text-sm text-[var(--md-on-surface)]';
export function browserFilters(params: URLSearchParams, rotation = ''): ContentBrowserFilters {
  return { type: params.get('type') === 'question' ? 'question' : 'card',
    status: params.get('status') === 'seen' ? 'seen' : params.get('status') === 'unseen' ? 'unseen' : 'all',
    rotation: params.has('rotation') ? params.get('rotation')! : rotation,
    cluster: params.get('cluster') ?? '',
    q: (params.get('q') ?? '').slice(0,120), topic: (params.get('topic') ?? '').slice(0,120), source: (params.get('source') ?? '').slice(0,120) };
}
export function browserParams(filters: ContentBrowserFilters): URLSearchParams {
  return new URLSearchParams({...filters});
}
function dateLabel(value: string | null) {
  if (!value) return 'Unseen';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Read-only manual browse. Nothing in this component creates a session or submits an answer. */
export function ContentBrowser({ userId, initialRotation = '', initialClusterId = '', topicLabel, topicSummary, refreshKey = 0, active = true, filters: controlledFilters, onFiltersChange, closeControl }: {
  userId: string; initialRotation?: string; initialClusterId?: string; topicLabel?: string; topicSummary?: string; refreshKey?: number; active?: boolean;
  filters?: ContentBrowserFilters; onFiltersChange?: (filters: ContentBrowserFilters) => void;
  closeControl?: React.ReactNode;
}) {
  const { data: session, status } = useSession();
  const [localFilters, setLocalFilters] = useState(() => browserFilters(new URLSearchParams({cluster:initialClusterId}), initialRotation));
  const filters = controlledFilters ?? localFilters;
  const update = (next: Partial<ContentBrowserFilters>) => {
    const value = {...filters, ...next};
    setLocalFilters(value); onFiltersChange?.(value);
  };
  if (status !== 'authenticated' || session?.user?.id !== userId) {
    return <div><div className="flex justify-end">{closeControl}</div><p role="status" className="py-4">{status === 'loading' ? 'Loading…' : 'Sign in to browse your content.'}</p></div>;
  }
  return <section className="text-[var(--md-on-surface)]" aria-label="Content browser">
    <header className="mb-3 flex items-center justify-between gap-3">
      <h1 className="min-w-0 text-xl font-semibold">{filters.cluster && topicLabel ? topicLabel : 'Browse content'}</h1>{closeControl}
    </header>
    {filters.cluster && topicSummary && <p className="mb-3 text-xs tabular-nums text-[var(--md-on-surface-variant)]">{topicSummary}</p>}
    <BrowserSearch key={`${filters.q}:${filters.topic}:${filters.source}`} filters={filters} onChange={update} />
    <div className="mb-3 grid grid-cols-3 gap-2">
      <select aria-label="Content type" className={browserControl} value={filters.type} onChange={e => update({type:e.target.value as ContentBrowserFilters['type'],cluster:e.target.value === 'question' ? '' : filters.cluster})}>
        <option value="card">Cards</option><option value="question">Questions</option>
      </select>
      <select aria-label="Review status" className={browserControl} value={filters.status} onChange={e=>update({status:e.target.value as ContentBrowserFilters['status']})}>
        <option value="all">All</option><option value="seen">Seen</option><option value="unseen">Unseen</option>
      </select>
      <select aria-label="Content scope" className={browserControl} value={filters.cluster ? '__topic' : filters.rotation} onChange={e=>update(e.target.value === '__topic' ? {rotation:initialRotation,cluster:initialClusterId,type:'card'} : {rotation:e.target.value,cluster:''})}>
        {initialClusterId && <option value="__topic">This topic</option>}
        {Array.from(new Set([initialRotation, filters.rotation].filter(Boolean))).map(r=><option key={r} value={r}>{rotationLabel(r)}</option>)}
        <option value="">All content</option>
      </select>
    </div>
    {active && <BrowserResults key={`${userId}:${refreshKey}:${browserParams(filters)}`} filters={filters} />}
  </section>;
}
function BrowserSearch({filters,onChange}:{filters:ContentBrowserFilters;onChange:(next:Partial<ContentBrowserFilters>)=>void}) {
  const [draft,setDraft]=useState({q:filters.q,topic:filters.topic,source:filters.source});
  const submit=(event:FormEvent)=>{event.preventDefault();onChange({q:draft.q.trim(),topic:draft.topic.trim(),source:draft.source.trim()});};
  return <form onSubmit={submit} className="mb-3">
    <div className="flex gap-2">
      <input aria-label="Search content" placeholder="Search content" type="search" maxLength={120} value={draft.q} onChange={e=>setDraft({...draft,q:e.target.value})} className={`${browserControl} flex-1`} />
      <button className={browserControl} type="submit">Search</button>
    </div>
    <details className="mt-1" open={undefined}>
      <summary className="w-fit cursor-pointer py-1 text-sm text-[var(--md-on-surface-variant)]">Topic / source{filters.topic || filters.source ? ' · filtered' : ''}</summary>
      <div className="mt-1 grid grid-cols-2 gap-2">
        <input aria-label="Topic filter" placeholder="Topic" className={browserControl} maxLength={120} value={draft.topic} onChange={e=>setDraft({...draft,topic:e.target.value})} />
        <input aria-label="Source filter" placeholder="Source" className={browserControl} maxLength={120} value={draft.source} onChange={e=>setDraft({...draft,source:e.target.value})} />
      </div>
    </details>
  </form>;
}
function BrowserResults({filters}:{filters:ContentBrowserFilters}) {
  const [page,setPage]=useState<BrowserPage|null>(null);
  const [request,setRequest]=useState({cursor:null as string|null,attempt:0});
  const [busy,setBusy]=useState(true);
  const [error,setError]=useState(false);
  const [denied,setDenied]=useState(false);
  const [selected,setSelected]=useState<string|null>(null);
  const [detail,setDetail]=useState<BrowserDetail|null>(null);
  const [detailError,setDetailError]=useState(false);
  const [detailAttempt,setDetailAttempt]=useState(0);
  const detailCache=useRef(new Map<string,BrowserDetail>());
  const lastFocus=useRef<HTMLButtonElement|null>(null);
  const resumeCursor=useRef<string|null>(null);
  const deliveredIds=useRef(new Set<string>());
  const query=browserParams(filters).toString();
  useEffect(()=>{
    const controller=new AbortController();let current=true;
    const timeout=setTimeout(()=>controller.abort(),15000);
    // Each API read stays bounded to 20 candidates. Search sparse pages sequentially,
    // within one 15-second budget, stopping at new results or true exhaustion.
    const knownIds=new Set(deliveredIds.current);
    const visited=new Set<string>();
    async function search() {
      let cursor=request.cursor;
      resumeCursor.current=cursor;
      while(current && !controller.signal.aborted) {
        if(cursor) { if(visited.has(cursor))throw new Error('Repeated cursor'); visited.add(cursor); }
        const params=new URLSearchParams(query);if(cursor)params.set('cursor',cursor);
        const response=await fetch(`/api/study/browser?${params}`,{signal:controller.signal,cache:'no-store'});
        if(!current)return;
        if([401,403,404].includes(response.status)){setDenied(true);setPage(null);detailCache.current.clear();return;}
        if(!response.ok)throw new Error();
        const result=await response.json() as BrowserPage;
        if(!current)return;
        if(controller.signal.aborted)throw new Error('Search timed out');
        const novel=result.items.filter(item=>{if(knownIds.has(item.id))return false;knownIds.add(item.id);return true;});
        if(novel.length || !result.nextCursor) {
          deliveredIds.current=knownIds;
          setPage(old=>({items:[...(old?.items ?? []),...novel],nextCursor:result.nextCursor}));
          return;
        }
        cursor=result.nextCursor;
        resumeCursor.current=cursor;
      }
      if(current)throw new Error('Search timed out');
    }
    void search().catch(()=>{if(current)setError(true);}).finally(()=>{clearTimeout(timeout);if(current)setBusy(false);});
    return()=>{current=false;clearTimeout(timeout);controller.abort();};
  },[query,request]);
  useEffect(()=>{
    if(!selected)return;
    const cached=detailCache.current.get(selected);if(cached){setDetail(cached);return;}
    const controller=new AbortController();let current=true;const timeout=setTimeout(()=>controller.abort(),15000);
    const params=new URLSearchParams(query);params.set('item',selected);
    fetch(`/api/study/browser?${params}`,{signal:controller.signal,cache:'no-store'})
      .then(async response=>{if(!current)return;if([401,403,404].includes(response.status)){setDenied(true);setPage(null);setDetail(null);detailCache.current.clear();return;}if(!response.ok)throw new Error();const result=await response.json() as BrowserDetail;if(current){detailCache.current.set(selected,result);if(detailCache.current.size>40)detailCache.current.delete(detailCache.current.keys().next().value!);setDetail(result);}})
      .catch(()=>{if(current)setDetailError(true);}).finally(()=>clearTimeout(timeout));
    return()=>{current=false;clearTimeout(timeout);controller.abort();};
  },[selected,query,detailAttempt]);
  function load(){setBusy(true);setError(false);setRequest(old=>({cursor:error?resumeCursor.current:page?.nextCursor??null,attempt:old.attempt+1}));}
  function back(){setSelected(null);setDetail(null);setDetailError(false);requestAnimationFrame(()=>lastFocus.current?.focus());}
  if(denied)return <p role="alert" className="py-4">Your access has ended. Sign in again to browse your content.</p>;
  return <div>
    <div hidden={selected!==null}>
      <ul className="divide-y divide-[var(--md-outline-variant)]">
        {page?.items.map(item=><li key={item.id}>
          <button type="button" className="block w-full rounded-lg py-3 text-left focus-visible:outline-2 focus-visible:outline-[var(--md-primary)]" onClick={event=>{lastFocus.current=event.currentTarget;setSelected(item.id);setDetailError(false);}}>
            <span className="line-clamp-2 break-words text-sm leading-relaxed">{item.text}</span>
            <span className="mt-1 flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-[var(--md-on-surface-variant)]">
              <span className="min-w-0 truncate">{item.topics[0] ?? item.rotation ?? item.source ?? item.type}</span>
              <span className="shrink-0 tabular-nums">{item.reviewCount} Reviews · {dateLabel(item.lastReviewedAt)}</span>
            </span>
          </button>
        </li>)}
      </ul>
      {page?.items.length===0&&!page.nextCursor&&!busy&&!error&&<p className="py-4">No content matches these filters.</p>}
      {busy&&<p className="py-4" role="status">Loading content…</p>}
      {error&&<p role="alert" className="py-2">Could not load content.</p>}
      {!busy&&(error||page?.nextCursor)&&<button className={`${browserControl} mt-3`} onClick={load}>{error?'Retry':'Load more'}</button>}
    </div>
    {selected&&<div>
      <button className={`${browserControl} mb-3`} onClick={back}>← Back to results</button>
      {detail?<ItemDetail detail={detail}/>:detailError?<div role="alert">Could not load this item. <button className={browserControl} onClick={()=>{setDetailError(false);setDetailAttempt(n=>n+1);}}>Retry</button></div>:<p role="status">Loading item…</p>}
    </div>}
  </div>;
}
function ItemDetail({detail}:{detail:BrowserDetail}) {
  const {item,preview}=detail;
  const options=Array.isArray(preview.options)?preview.options:[];
  return <article aria-label="Item preview" className="space-y-3">
    <p className="text-xs tabular-nums text-[var(--md-on-surface-variant)]">{item.reviewCount} Reviews · {dateLabel(item.lastReviewedAt)} · {item.source}</p>
    <p className="whitespace-pre-wrap break-words leading-relaxed">{preview.front??preview.stem}</p>
    {options.length>0&&<ul className="space-y-2">{options.map((raw,index)=>{const option=typeof raw==='object'&&raw!==null?raw as Record<string,unknown>:{};return <li key={index} className="rounded-lg border border-[var(--md-outline-variant)] p-2 text-sm">{String(option.label??index+1)}. {String(option.text??raw)}{option.isCorrect===true&&<strong> ✓</strong>}</li>;})}</ul>}
    {preview.back&&<div className="whitespace-pre-wrap break-words rounded-lg bg-[var(--md-surface-container-low)] p-3">{preview.back}</div>}
    {preview.context&&<p className="whitespace-pre-wrap break-words text-sm text-[var(--md-on-surface-variant)]">{preview.context}</p>}
    <details><summary className="cursor-pointer py-2 text-sm">Review history</summary>
      <ul className="divide-y divide-[var(--md-outline-variant)] text-sm">{detail.history.map(event=><li key={event.id} className="flex justify-between gap-3 py-2"><time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time><span className="capitalize">{event.rating}</span></li>)}</ul>
      {detail.history.length===0&&<p className="py-2 text-sm">{item.reviewCount > 0 ? 'Detailed review history unavailable.' : 'No recorded reviews.'}</p>}
      {detail.historyHasMore&&<p className="text-xs">Showing the latest {detail.history.length} recorded reviews.</p>}
      <p className="mt-2 text-xs text-[var(--md-on-surface-variant)]">{detail.historyNote}</p>
    </details>
    <a className="inline-flex min-h-11 items-center text-sm text-[var(--md-primary)] underline" href={item.href} target="_blank" rel="noopener noreferrer">Full item ↗</a>
  </article>;
}
