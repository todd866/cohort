import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { getRotation } from '@/lib/rotation-metadata';

interface RelatedLink {
  href: string;
  title: string;
  description: string;
}

interface RotationLandingPageProps {
  rotationId: string;
  relatedLinks?: RelatedLink[];
}

export function RotationLandingPage({
  rotationId,
  relatedLinks = [],
}: RotationLandingPageProps) {
  const rotation = getRotation(rotationId);
  if (!rotation) return null;

  const weeks = Object.entries(rotation.weeks).map(([num, week]) => ({
    num: parseInt(num),
    ...week,
  }));

  return (
    <div className="min-h-screen px-6 py-8 pb-28">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8">
          <Link
            href="/content"
            className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-[var(--md-primary)] hover:underline"
          >
            ← Content
          </Link>
          <h1 className="text-3xl font-bold tracking-tight text-[var(--md-on-surface)]">
            {rotation.name}
          </h1>
          <p className="mt-1 text-[var(--md-on-surface-variant)]">
            Specialty guides and week notes
          </p>
        </header>

        {relatedLinks.length > 0 && (
          <nav aria-label="Related reading" className="mb-8 grid gap-3 sm:grid-cols-2">
            {relatedLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="rounded-2xl border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-lowest)] p-4 transition-colors hover:border-[var(--md-primary)]"
              >
                <h2 className="font-semibold text-[var(--md-on-surface)]">{link.title}</h2>
                <p className="mt-1 text-sm text-[var(--md-on-surface-variant)]">
                  {link.description}
                </p>
              </Link>
            ))}
          </nav>
        )}

        {rotation.subrotations.length > 0 && (
          <section className="mb-8" aria-labelledby="guides-heading">
            <h2 id="guides-heading" className="mb-4 text-lg font-semibold text-[var(--md-on-surface)]">
              Specialty reference guides
            </h2>
            <div className={`grid grid-cols-1 gap-3 ${rotation.subrotationGridCols === 2 ? 'md:grid-cols-2' : rotation.subrotationGridCols === 4 ? 'md:grid-cols-4' : 'md:grid-cols-3'}`}>
              {rotation.subrotations.map((sub) => (
                <Link key={sub.slug} href={`/${rotationId}/${sub.slug}`}>
                  <Card variant="filled" className="h-full cursor-pointer p-4 transition-shadow hover:shadow-md">
                    <h3 className="font-semibold text-[var(--md-on-surface)]">{sub.title}</h3>
                    <p className="mt-1 text-sm text-[var(--md-on-surface-variant)]">
                      {sub.description}
                    </p>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        )}

        <section aria-labelledby="weeks-heading">
          <h2 id="weeks-heading" className="mb-3 text-lg font-semibold text-[var(--md-on-surface)]">
            Weeks
          </h2>
          <ol className="divide-y divide-[var(--md-outline-soft)] overflow-hidden rounded-2xl border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-lowest)]">
            {weeks.map((week) => (
              <li key={week.num}>
                <Link
                  href={`/${rotationId}/week/${week.num}`}
                  className="flex items-start gap-4 px-4 py-3.5 transition-colors hover:bg-[var(--md-surface-container)]"
                >
                  <span className="w-6 shrink-0 text-right text-sm font-bold tabular-nums text-[var(--md-primary)]">
                    {week.num}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="font-semibold text-[var(--md-on-surface)]">
                      {week.title}
                    </span>
                    {week.topics.length > 0 && (
                      <span className="mt-0.5 block text-sm text-[var(--md-on-surface-variant)]">
                        {week.topics.slice(0, 4).join(' · ')}
                        {week.topics.length > 4 ? ` · +${week.topics.length - 4} more` : ''}
                      </span>
                    )}
                  </span>
                  <span className="sr-only">Week {week.num}</span>
                </Link>
              </li>
            ))}
          </ol>
        </section>

        {rotation.extraSections?.map((section) => (
          <div key={section.href} className="mt-8 border-t border-[var(--md-outline-variant)] pt-6">
            <Link
              href={section.href}
              className="block rounded-2xl border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)] p-4 transition-colors hover:border-[var(--md-primary)]"
            >
              <div className="font-medium text-[var(--md-on-surface)]">{section.title}</div>
              <div className="mt-1 text-xs text-[var(--md-on-surface-variant)]">{section.subtitle}</div>
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
