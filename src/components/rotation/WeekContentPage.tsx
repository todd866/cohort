import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { getRotation, getWeekMeta, getWeekCount } from '@/lib/rotation-metadata';
import { deepDiveMetaBySlug } from '@/lib/deep-dives';
import { DeepDive } from '@/components/content';
import { WeekContentWithTabs } from './WeekContentWithTabs';
import { ComponentType } from 'react';

interface WeekContentPageProps {
  rotationId: string;
  weekNum: number;
  Content: ComponentType | null;
  SupplementaryContent?: ComponentType | null;
  CsdContent?: ComponentType | null;
}

export function WeekContentPage({
  rotationId,
  weekNum,
  Content,
  SupplementaryContent,
  CsdContent,
}: WeekContentPageProps) {
  const rotation = getRotation(rotationId);
  const week = getWeekMeta(rotationId, weekNum);

  if (!rotation || !week) {
    notFound();
  }

  const relatedDeepDives = Object.values(deepDiveMetaBySlug).filter(
    (dd) => dd.rotation === rotationId && dd.week === weekNum
  );

  return (
    <div className="min-h-screen">
      {/* Header — scrolls away naturally, not sticky */}
      <header className="bg-[var(--md-surface)] border-b border-[var(--md-outline-variant)]">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <Link
                href={`/${rotationId}`}
                className="text-sm text-[var(--md-primary)] hover:underline mb-1 inline-block"
              >
                ← {rotation.shortName}
              </Link>
              <h1 className="text-xl font-bold text-[var(--md-on-surface)]">
                Week {weekNum}: {week.title}
              </h1>
            </div>
            <div className="flex items-center gap-2">
              <Link href={`/${rotationId}/week/${weekNum}/review`}>
                <Button variant="filled" size="sm">
                  Quiz
                </Button>
              </Link>
              {week.prevWeek && (
                <Link href={`/${rotationId}/week/${week.prevWeek}`}>
                  <Button variant="text" size="sm">
                    ← Prev
                  </Button>
                </Link>
              )}
              {week.nextWeek && (
                <Link href={`/${rotationId}/week/${week.nextWeek}`}>
                  <Button variant="text" size="sm">
                    Next →
                  </Button>
                </Link>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Topics */}
      <div className="max-w-4xl mx-auto px-6 py-4">
        <div className="flex flex-wrap gap-2 mb-6">
          {week.topics.map((topic) => (
            <span
              key={topic}
              className="px-3 py-1 text-sm font-medium rounded-full bg-[var(--md-secondary-container)] text-[var(--md-on-secondary-container)]"
            >
              {topic}
            </span>
          ))}
        </div>

        {relatedDeepDives.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-sm font-semibold text-[var(--md-on-surface)]">
                Deep dives for this week
              </h2>
              <Link
                href="/deep-dive"
                className="text-sm text-[var(--md-primary)] hover:underline"
              >
                All deep dives →
              </Link>
            </div>
            <div className="mt-2">
              {relatedDeepDives.map((dd) => (
                <DeepDive
                  key={dd.slug}
                  href={`/deep-dive/${dd.slug}`}
                  title={dd.title}
                  description={dd.description}
                  duration={dd.duration}
                  hasVideo={dd.hasVideo}
                  id={dd.slug}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Content Area */}
      <WeekContentWithTabs
        prevWeekHref={week.prevWeek ? `/${rotationId}/week/${week.prevWeek}` : null}
        nextWeekHref={week.nextWeek ? `/${rotationId}/week/${week.nextWeek}` : null}
      >
        {Content ? (
          <>
            <Content />
            {SupplementaryContent && (
              <>
                <hr className="my-12 border-[var(--md-outline-variant)]" />
                <SupplementaryContent />
              </>
            )}
            {CsdContent && (
              <>
                <hr className="my-12 border-[var(--md-outline-variant)]" />
                <CsdContent />
              </>
            )}
          </>
        ) : (
          <div className="p-8 rounded-xl bg-[var(--md-surface-container)] text-center">
            <p className="text-[var(--md-on-surface-variant)] mb-4">
              Content for Week {weekNum}: {week.title} is being prepared.
            </p>
            <p className="text-sm text-[var(--md-on-surface-variant)]">
              Check back soon for the full content.
            </p>
          </div>
        )}
      </WeekContentWithTabs>

      {/* Navigation Footer */}
      <nav className="max-w-4xl mx-auto px-6 py-8 border-t border-[var(--md-outline-variant)]">
        <div className="flex justify-between">
          {week.prevWeek ? (
            <Link href={`/${rotationId}/week/${week.prevWeek}`}>
              <Button variant="outlined">
                ← Week {week.prevWeek}: {getWeekMeta(rotationId, week.prevWeek)?.title}
              </Button>
            </Link>
          ) : (
            <div />
          )}
          {week.nextWeek ? (
            <Link href={`/${rotationId}/week/${week.nextWeek}`}>
              <Button variant="filled">
                Week {week.nextWeek}: {getWeekMeta(rotationId, week.nextWeek)?.title} →
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

/**
 * Helper to load an MDX component from a content map, returning null if not found.
 */
export async function loadMdxContent(
  contentMap: Record<number, () => Promise<{ default: ComponentType }>>,
  weekNum: number
): Promise<ComponentType | null> {
  if (!contentMap[weekNum]) return null;
  try {
    const mdxModule = await contentMap[weekNum]();
    return mdxModule.default;
  } catch {
    return null;
  }
}

/**
 * Generate static params from rotation week count.
 */
export function generateWeekParams(rotationId: string) {
  const weekCount = getWeekCount(rotationId);
  return Array.from({ length: weekCount }, (_, i) => ({
    week: (i + 1).toString(),
  }));
}
