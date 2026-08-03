import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { ReviewModeProvider } from '@/components/review/ReviewModeProvider';
import { getRotation, getSubrotation } from '@/lib/rotation-metadata';
import { ComponentType } from 'react';

interface SubrotationReviewPageProps {
  rotationId: string;
  subrotation: string;
  Content: ComponentType | null;
}

export function SubrotationReviewPage({ rotationId, subrotation, Content }: SubrotationReviewPageProps) {
  const rotation = getRotation(rotationId);
  const meta = getSubrotation(rotationId, subrotation);

  if (!rotation || !meta) {
    notFound();
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 bg-[var(--md-surface)]/95 backdrop-blur border-b border-[var(--md-outline-variant)]">
        <div className="max-w-4xl mx-auto px-6 py-3">
          <Link
            href={`/${rotationId}/${subrotation}`}
            className="text-sm text-[var(--md-primary)] hover:underline"
          >
            &larr; Back to {meta.title}
          </Link>
        </div>
      </header>

      <article className="max-w-4xl mx-auto px-6 py-8 pb-16">
        <div className="mb-6 p-4 rounded-xl bg-[var(--md-primary-container)]">
          <h2 className="font-semibold text-[var(--md-on-primary-container)]">
            🎯 Quiz Mode: {meta.title}
          </h2>
          <p className="text-sm text-[var(--md-on-primary-container)] opacity-80 mt-1">
            MCQs will appear as you scroll through the content. Test your knowledge!
          </p>
        </div>

        <ReviewModeProvider
          enabled
          rotation={rotationId}
          topics={meta.reviewTopics}
        >
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
        </ReviewModeProvider>
      </article>

      <nav className="max-w-4xl mx-auto px-6 py-8 border-t border-[var(--md-outline-variant)]">
        <div className="flex justify-between">
          <Link href={`/${rotationId}/${subrotation}`}>
            <Button variant="outlined">
              &larr; Back to Notes
            </Button>
          </Link>
          <Link href={`/${rotationId}`}>
            <Button variant="filled">
              {rotation.shortName} Overview
            </Button>
          </Link>
        </div>
      </nav>
    </div>
  );
}
