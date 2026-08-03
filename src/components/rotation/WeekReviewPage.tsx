import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { getWeekMeta } from '@/lib/rotation-metadata';
import { ReviewModeProvider } from '@/components/review/ReviewModeProvider';
import { ComponentType } from 'react';

interface WeekReviewPageProps {
  rotationId: string;
  weekNum: number;
  Content: ComponentType | null;
  SupplementaryContent?: ComponentType | null;
}

export function WeekReviewPage({ rotationId, weekNum, Content, SupplementaryContent }: WeekReviewPageProps) {
  const week = getWeekMeta(rotationId, weekNum);

  if (!week) {
    notFound();
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 bg-[var(--md-surface)]/95 backdrop-blur border-b border-[var(--md-outline-variant)]">
        <div className="max-w-4xl mx-auto px-6 py-3">
          <Link
            href={`/${rotationId}/week/${weekNum}`}
            className="text-sm text-[var(--md-primary)] hover:underline"
          >
            &larr; Back to notes
          </Link>
        </div>
      </header>

      <article className="max-w-4xl mx-auto px-6 py-8 pb-16">
        <ReviewModeProvider
          enabled
          rotation={rotationId}
          week={weekNum}
          topics={week.topics}
        >
          <div className="prose prose-lg max-w-none">
            {Content ? (
              <>
                <Content />
                {SupplementaryContent && (
                  <>
                    <hr className="my-12 border-[var(--md-outline-variant)]" />
                    <SupplementaryContent />
                  </>
                )}
              </>
            ) : (
              <div className="p-8 rounded-xl bg-[var(--md-surface-container)] text-center">
                <p className="text-[var(--md-on-surface-variant)] mb-4">
                  Content for Week {weekNum}: {week.title} is being prepared.
                </p>
                <p className="text-sm text-[var(--md-on-surface-variant)]">
                  Check back soon.
                </p>
              </div>
            )}
          </div>
        </ReviewModeProvider>
      </article>

      <nav className="max-w-4xl mx-auto px-6 py-8 border-t border-[var(--md-outline-variant)]">
        <div className="flex justify-between">
          {week.prevWeek ? (
            <Link href={`/${rotationId}/week/${week.prevWeek}/review`}>
              <Button variant="outlined">
                &larr; Week {week.prevWeek} Review
              </Button>
            </Link>
          ) : (
            <div />
          )}
          {week.nextWeek ? (
            <Link href={`/${rotationId}/week/${week.nextWeek}/review`}>
              <Button variant="filled">
                Week {week.nextWeek} Review &rarr;
              </Button>
            </Link>
          ) : (
            <Link href={`/${rotationId}`}>
              <Button variant="filled">
                Back to Overview
              </Button>
            </Link>
          )}
        </div>
      </nav>
    </div>
  );
}
