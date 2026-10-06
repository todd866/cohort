import Link from 'next/link';

export function ProfileDestination({ href, title, description }: { href: string; title: string; description?: string }) {
  return <Link href={href} className="flex min-h-16 items-center justify-between gap-4 rounded-xl border border-[var(--md-outline-variant)] px-4 py-3 text-[var(--md-on-surface)] transition-colors hover:bg-[var(--md-surface-container-high)]"><span><span className="block text-sm font-semibold">{title}</span>{description && <span className="mt-0.5 block text-xs text-[var(--md-on-surface-variant)]">{description}</span>}</span><span aria-hidden="true" className="text-[var(--md-on-surface-variant)]">→</span></Link>;
}
