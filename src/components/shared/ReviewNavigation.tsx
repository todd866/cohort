'use client';
import Link from 'next/link';
import type { ComponentType, MouseEvent as ReactMouseEvent } from 'react';

type Icon = ComponentType<{ className?: string }>;
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
}

function ItemLink({ item, active, compact, prefetch, onNavigate, onHover }: { item: ReviewNavigationItem; active: boolean; compact?: boolean; prefetch: boolean | undefined; onNavigate: ReviewNavigationProps['onNavigate']; onHover?: (href: string) => void }) {
  return <Link key={item.href} href={item.href} prefetch={prefetch} aria-current={active ? 'page' : undefined} onClick={(event) => onNavigate(event, item.href)} onMouseEnter={() => onHover?.(item.href)} onTouchStart={() => onHover?.(item.href)} aria-label={item.label} className={compact ? `relative flex flex-col items-center gap-1 p-2 rounded-lg min-w-[64px] transition-colors ${active ? 'text-[var(--md-on-secondary-container)]' : 'text-[var(--md-on-surface-variant)] hover:text-[var(--md-on-surface)]'}` : `relative flex flex-col items-center gap-1 p-3 rounded-lg w-16 overflow-hidden transition-colors duration-200 ${active ? 'bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)] shadow-[inset_0_1px_0_rgba(255,255,255,0.38)]' : 'text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)]'}`}>
    {active && (compact ? <span aria-hidden="true" className="absolute -top-2 h-1 w-8 rounded-full bg-[var(--md-tertiary)]" /> : <span aria-hidden="true" className="absolute left-1 top-3 bottom-3 w-1 rounded-full bg-[var(--md-tertiary)]" />)}
    {compact ? <div className={`p-1.5 rounded-full ${active ? 'bg-[var(--md-secondary-container)] shadow-[inset_0_1px_0_rgba(255,255,255,0.38)]' : ''}`}><item.icon className="w-6 h-6" /></div> : <><item.icon className="w-6 h-6" /><span className="text-center text-xs font-medium">{item.label}</span></>}
    {compact && <span className="text-xs font-medium">{item.shortLabel || item.label}</span>}
  </Link>;
}

export function ReviewNavigation({ items, mobileItems, profile, logo, isActive, prefetch, onNavigate, onHover }: ReviewNavigationProps) {
  return <>
    <nav aria-label="Main navigation" className="hidden md:flex fixed left-0 top-0 h-full w-20 flex-col items-center py-6 border-r border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)]/95 backdrop-blur z-50 shadow-[0_0_24px_rgba(21,35,46,0.06)]">
      <Link href={logo.href} prefetch={prefetch(logo.href)} aria-label={logo.label} onClick={(event) => onNavigate(event, logo.href)} className="mb-4 p-2 rounded-lg hover:bg-[var(--md-surface-container-high)] transition-colors"><div className="w-10 h-10 rounded-lg bg-[var(--md-primary)] flex items-center justify-center shadow-[inset_0_-3px_0_rgba(0,0,0,0.16),0_8px_18px_rgba(33,77,115,0.18)]"><span className="text-[var(--md-on-primary)] font-bold text-lg">{logo.text}</span></div></Link>
      <div className="flex flex-col items-center gap-2 flex-1">{items.map(item => <ItemLink key={item.href} item={item} active={isActive(item.href)} prefetch={prefetch(item.href)} onNavigate={onNavigate} onHover={onHover} />)}</div>
      <ItemLink item={{ href: profile.href, label: profile.label, icon: ({ className }) => profile.image ? <img src={profile.image} alt="" className={`${className} rounded-full border border-[var(--md-outline-variant)]`} /> : <UserIcon className={className} /> }} active={profile.active} prefetch={prefetch(profile.href)} onNavigate={onNavigate} />
    </nav>
    <nav aria-label="Main navigation" className="md:hidden fixed bottom-0 left-0 right-0 h-20 border-t border-[var(--md-outline-soft)] bg-[var(--md-surface)]/95 backdrop-blur z-50 flex items-center justify-around px-4 shadow-[0_-10px_28px_rgba(21,35,46,0.08)] safe-area-pb">{mobileItems.map(item => <ItemLink key={item.href} item={item} active={isActive(item.href)} compact prefetch={prefetch(item.href)} onNavigate={onNavigate} onHover={onHover} />)}</nav>
  </>;
}
function UserIcon({ className }: { className?: string }) { return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>; }
