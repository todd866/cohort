'use client';
import {useEffect,useRef,useState,type ReactNode} from 'react';

export function ReviewOptions({children,onOpenChange}: {children:ReactNode;onOpenChange?:(open:boolean)=>void}) {
  const [open,setOpen]=useState(false);
  const root=useRef<HTMLDivElement>(null);
  const trigger=useRef<HTMLButtonElement>(null);
  const panel=useRef<HTMLDivElement>(null);
  const change=useRef(onOpenChange);
  useEffect(()=>{change.current=onOpenChange;},[onOpenChange]);
  useEffect(()=>{
    change.current?.(open);
    if(!open)return;
    panel.current?.querySelector<HTMLElement>('button,a')?.focus();
    const close=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setOpen(false);trigger.current?.focus();}};
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    document.addEventListener('keydown',close);document.addEventListener('pointerdown',outside);
    return()=>{document.removeEventListener('keydown',close);document.removeEventListener('pointerdown',outside);};
  },[open]);
  return <div ref={root} className="relative shrink-0">
    <button ref={trigger} type="button" aria-label="Review options" aria-haspopup="dialog" aria-expanded={open} onClick={()=>setOpen(value=>!value)} className="inline-flex h-[44px] w-[44px] items-center justify-center rounded-full border border-[var(--md-outline-variant)] text-base text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)]">⋯</button>
    {open && <div ref={panel} role="dialog" aria-label="Review options" className="absolute right-0 top-full z-50 mt-1 flex max-h-[min(70vh,max(5rem,calc(100dvh-10rem)))] w-[min(18rem,calc(100vw-1.5rem))] flex-col items-start gap-3 overflow-y-auto rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface)] p-3 text-sm shadow-xl">{children}</div>}
  </div>;
}
