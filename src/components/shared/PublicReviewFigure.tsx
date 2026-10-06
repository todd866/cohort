'use client';
import {useEffect, useRef, useState} from 'react';
import {fetchWithDeadline, CLIENT_FETCH_DEADLINE_MS} from '@/lib/fetch-with-deadline';

const prepared = new Map<string, Promise<string>>();
export function preparePublicReviewFigure(src: string): Promise<string> {
  const cached = prepared.get(src);
  if (cached) return cached;
  const promise = (async () => {
    const response = await fetchWithDeadline(src, {credentials:'omit'}, CLIENT_FETCH_DEADLINE_MS);
    if (!response.ok) throw new Error('Picture could not be loaded');
    const url = URL.createObjectURL(await response.blob());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const image = new Image(); image.src = url;
      await Promise.race([image.decode(), new Promise<never>((_, reject) => {timer=setTimeout(()=>reject(new Error('Picture could not be decoded')),CLIENT_FETCH_DEADLINE_MS);})]);
      return url;
    } catch(error) {URL.revokeObjectURL(url); throw error;}
    finally {if(timer)clearTimeout(timer);}
  })();
  prepared.set(src,promise);
  void promise.catch(()=>{if(prepared.get(src)===promise)prepared.delete(src);});
  while(prepared.size>6){const oldest=prepared.keys().next().value!;const old=prepared.get(oldest);prepared.delete(oldest);void old?.then(url=>URL.revokeObjectURL(url)).catch(()=>{});}
  return promise;
}

/** Only server-admitted public assets enter this bounded, decoded image cache. */
type FigureProps = {src:string;alt:string;attribution:string;licenseUrl:string;onReady:(ready:boolean)=>void};
export function PublicReviewFigure(props: FigureProps) {
  return <PreparedFigure key={props.src} {...props} />;
}
function PreparedFigure({src,alt,attribution,licenseUrl,onReady}: FigureProps) {
  const [url,setUrl]=useState<string|null>(null);
  const [failed,setFailed]=useState(false);
  const [attempt,setAttempt]=useState(0);
  const ready=useRef(onReady);
  useEffect(()=>{ready.current=onReady;},[onReady]);
  useEffect(()=>{
    let alive=true;ready.current(false);
    void preparePublicReviewFigure(src).then(value=>{if(alive)setUrl(value);}).catch(()=>{if(alive)setFailed(true);});
    return()=>{alive=false;};
  },[src,attempt]);
  return <figure>
    {url && !failed && <img src={url} alt={alt} data-source={src} onLoad={()=>ready.current(true)} onError={()=>{ready.current(false);setFailed(true);}} className="mx-auto max-h-[65dvh] w-auto max-w-full rounded-lg object-contain"/>}
    {failed ? <div role="alert">Picture could not be loaded. <button className="min-h-11 underline" onClick={()=>{const old=prepared.get(src);prepared.delete(src);void old?.then(value=>URL.revokeObjectURL(value)).catch(()=>{});setFailed(false);setUrl(null);setAttempt(value=>value+1);}}>Retry picture</button></div> : !url && <p role="status">Preparing picture…</p>}
    <figcaption className="mt-2 text-xs text-[var(--md-on-surface-variant)]">{attribution} · <a href={licenseUrl}>Licence</a></figcaption>
  </figure>;
}
