import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { getRotation, getSubrotation, getSubrotations } from '@/lib/rotation-metadata';
import { ComponentType } from 'react';

interface SubrotationPageProps {
  rotationId: string;
  subrotation: string;
  Content: ComponentType | null;
}

export function SubrotationPage({ rotationId, subrotation, Content }: SubrotationPageProps) {
  const rotation = getRotation(rotationId);
  const meta = getSubrotation(rotationId, subrotation);
  const allSubrotations = getSubrotations(rotationId);

  if (!rotation || !meta) {
    notFound();
  }

  const otherSubrotations = allSubrotations.filter((s) => s.slug !== subrotation);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 bg-[var(--md-surface)]/95 backdrop-blur border-b border-[var(--md-outline-variant)]">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <Link
                href={`/${rotationId}`}
                className="text-sm text-[var(--md-primary)] hover:underline mb-1 inline-block"
              >
                &larr; {rotation.shortName}
              </Link>
              <h1 className="text-xl font-bold text-[var(--md-on-surface)]">
                {meta.title}
              </h1>
              <p className="text-sm text-[var(--md-on-surface-variant)] mt-1">
                {meta.description}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Link href={`/${rotationId}/${subrotation}/review`}>
                <Button variant="filled" size="sm">
                  Quiz
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-6 py-4">
        <div className="flex flex-wrap gap-2 mb-6">
          {meta.topics.map((topic) => (
            <span
              key={topic}
              className="px-3 py-1 text-sm font-medium rounded-full bg-[var(--md-secondary-container)] text-[var(--md-on-secondary-container)]"
            >
              {topic}
            </span>
          ))}
        </div>

        {otherSubrotations.length > 0 && (
          <div className="mb-6 p-4 rounded-xl bg-[var(--md-surface-container)]">
            <h2 className="text-sm font-semibold text-[var(--md-on-surface)] mb-2">
              Other Sub-Rotations
            </h2>
            <div className="flex flex-wrap gap-2">
              {otherSubrotations.map((s) => (
                <Link key={s.slug} href={`/${rotationId}/${s.slug}`}>
                  <Button variant="outlined" size="sm">
                    {s.title}
                  </Button>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>

      <article className="max-w-4xl mx-auto px-6 pb-16">
        <div className="prose prose-lg max-w-none">
          {Content ? (
            <Content />
          ) : (
            <div className="p-8 rounded-xl bg-[var(--md-surface-container)] text-center">
              <p className="text-[var(--md-on-surface-variant)] mb-4">
                Content for {meta.title} is being prepared.
              </p>
            </div>
          )}
        </div>
      </article>

      <nav className="max-w-4xl mx-auto px-6 py-8 border-t border-[var(--md-outline-variant)]">
        <div className="flex justify-center">
          <Link href={`/${rotationId}`}>
            <Button variant="filled">
              Back to {rotation.shortName} Overview
            </Button>
          </Link>
        </div>
      </nav>
    </div>
  );
}
