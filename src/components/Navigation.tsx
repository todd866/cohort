'use client';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { ReviewNavigation } from '@/components/shared/ReviewNavigation';
function CardsIcon({ className }: { className?: string }) { return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M7 8h10M7 12h6" /></svg>; }
function UserIcon({ className }: { className?: string }) { return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>; }
/** Public navigation uses the same reviewed primitive as the hosted Cohort shell. */
export function Navigation(_props: { isCohortHost?: boolean } = {}) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const profile = session?.user ? '/profile' : '/auth/signin';
  const item = { href: '/', label: 'Review', icon: CardsIcon };
  return <ReviewNavigation items={[item]} mobileItems={[item, { href: profile, label: session?.user ? 'Profile' : 'Sign in', icon: UserIcon }]} profile={{ href: profile, label: session?.user ? 'Profile' : 'Sign in', active: pathname.startsWith('/profile') }} logo={{ href: '/', label: 'Home', text: 'C' }} isActive={(href) => pathname === href || (href !== '/' && pathname.startsWith(href))} prefetch={() => false} onNavigate={() => {}} />;
}
