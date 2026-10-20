'use client';
import Link from 'next/link';
import type { ComponentType, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { MD3_MARK_DIGITS, MD3_MARK_LETTERS } from '@/lib/brand/md3-mark';

type Icon = ComponentType<{ className?: string }>;

function BrandMark({ text }: { text: string }) {
  const year = /^M([123])$/.exec(text)?.[1] as keyof typeof MD3_MARK_DIGITS | undefined;
  return <div aria-hidden="true" className="w-10 h-10 rounded-xl bg-[var(--md-primary)] text-[var(--md-on-primary)] flex items-center justify-center">
    {year ? <svg viewBox="0 0 48 48" className="h-10 w-10" fill="currentColor" focusable="false">
      <path d={MD3_MARK_LETTERS} />
      <path d={MD3_MARK_DIGITS[year]} />
    </svg> : <span className="font-bold text-lg">{text}</span>}
  </div>;
}
export type ReviewNavigationItem = { href: string; label: string; shortLabel?: string; icon: Icon };
export interface ReviewNavigationProps {
  items: readonly ReviewNavigationItem[];
  mobileItems: readonly ReviewNavigationItem[];
  profile: { href: string; label: string; active: boolean; image?: string | null };
  logo: { href: string; label: string; text: string };
  isActive: (href: string) => boolean;
  prefetch: (href: string) => boolean | undefined;
  onNavigate: (event: ReactMouseEvent<HTMLAnchorElement>, href: string) => void;
  onHover?: (href: string) => void;
  /** The connection indicator's slot; absent (zero width) while connected. */
  status?: (placement: 'above' | 'right') => ReactNode;
}

function ItemLink({ item, active, compact, prefetch, onNavigate, onHover }: { item: ReviewNavigationItem; active: boolean; compact?: boolean; prefetch: boolean | undefined; onNavigate: ReviewNavigationProps['onNavigate']; onHover?: (href: string) => void }) {
  return <Link key={item.href} href={item.href} prefetch={prefetch} aria-current={active ? 'page' : undefined} onClick={(event) => onNavigate(event, item.href)} onMouseEnter={() => onHover?.(item.href)} onTouchStart={() => onHover?.(item.href)} aria-label={item.label} className={compact ? `relative flex flex-col items-center gap-1 p-2 rounded-lg min-w-[64px] transition-colors ${active ? 'text-[var(--md-on-primary-container)]' : 'text-[var(--md-on-surface-variant)] hover:text-[var(--md-on-surface)]'}` : `relative flex flex-col items-center gap-1 p-3 rounded-xl w-16 overflow-hidden transition-colors duration-200 ${active ? 'bg-[var(--md-primary-container)]/65 text-[var(--md-on-primary-container)]' : 'text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)]'}`}>
    {compact ? <div className={`p-1.5 rounded-full ${active ? 'bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)]' : ''}`}><item.icon className="w-6 h-6" /></div> : <><item.icon className="w-6 h-6" /><span className="text-center text-xs font-medium">{item.label}</span></>}
    {compact && <span className="text-xs font-medium">{item.shortLabel || item.label}</span>}
  </Link>;
}

export function ReviewNavigation({ items, mobileItems, profile, logo, isActive, prefetch, onNavigate, onHover, status }: ReviewNavigationProps) {
  return <>
    <nav aria-label="Main navigation" className="hidden md:flex fixed left-0 top-0 h-full w-20 flex-col items-center py-6 border-r border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)] z-50">
      <Link href={logo.href} prefetch={prefetch(logo.href)} aria-label={logo.label} onClick={(event) => onNavigate(event, logo.href)} className="mb-4 p-2 rounded-lg hover:bg-[var(--md-surface-container-high)] transition-colors"><BrandMark text={logo.text} /></Link>
      <div className="flex flex-col items-center gap-2 flex-1">{items.map(item => <ItemLink key={item.href} item={item} active={isActive(item.href)} prefetch={prefetch(item.href)} onNavigate={onNavigate} onHover={onHover} />)}</div>
      {status ? <div className="mb-2 flex justify-center empty:hidden">{status('right')}</div> : null}
      <ItemLink item={{ href: profile.href, label: profile.label, icon: ({ className }) => profile.image ? <img src={profile.image} alt="" className={`${className} rounded-full border border-[var(--md-outline-variant)]`} /> : <UserIcon className={className} /> }} active={profile.active} prefetch={prefetch(profile.href)} onNavigate={onNavigate} />
    </nav>
    <nav aria-label="Main navigation" className="md:hidden fixed bottom-0 left-0 right-0 h-20 border-t border-[var(--md-outline-soft)] bg-[var(--md-surface)]/95 backdrop-blur z-50 flex items-center justify-around px-4 safe-area-pb">{mobileItems.map(item => <ItemLink key={item.href} item={item} active={isActive(item.href)} compact prefetch={prefetch(item.href)} onNavigate={onNavigate} onHover={onHover} />)}{status?.('above')}</nav>
  </>;
}
function UserIcon({ className }: { className?: string }) { return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>; }
