'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';

const PUBLIC_NAV_ITEMS = [
  { href: '/usmle/step1', label: 'Study' },
];

function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={active
        ? 'rounded-xl bg-[var(--md-primary-container)] px-3 py-2 font-medium text-[var(--md-on-primary-container)]'
        : 'rounded-xl px-3 py-2 text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)]'}
    >
      {label}
    </Link>
  );
}

export function Navigation() {
  const { data: session } = useSession();
  const profileHref = session?.user ? '/profile' : '/auth/signin';
  return (
    <>
      <nav aria-label="Main navigation" className="fixed left-0 top-0 z-50 hidden h-full w-24 flex-col gap-2 border-r border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)] p-3 md:flex">
        <Link href="/usmle/step1" aria-label="Home" className="mb-4 rounded-xl bg-[var(--md-primary)] px-3 py-2 text-center font-bold text-[var(--md-on-primary)]">
          cohort.md
        </Link>
        {PUBLIC_NAV_ITEMS.map((item) => <NavLink key={item.href} {...item} />)}
        <div className="mt-auto"><NavLink href={profileHref} label="Profile" /></div>
      </nav>
      <nav aria-label="Mobile navigation" className="fixed inset-x-0 bottom-0 z-50 flex justify-around border-t border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)] p-2 md:hidden">
        {PUBLIC_NAV_ITEMS.map((item) => <NavLink key={item.href} {...item} />)}
        <NavLink href={profileHref} label="Profile" />
      </nav>
    </>
  );
}
