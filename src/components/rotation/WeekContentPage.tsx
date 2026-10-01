import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getRotation, getWeekMeta, getWeekCount } from '@/lib/rotation-metadata';
import { deepDiveMetaBySlug } from '@/lib/deep-dives';
import { DeepDive } from '@/components/content';
import { WeekContentWithTabs } from './WeekContentWithTabs';
import { ComponentType } from 'react';
import { renderMdxContent } from '@/components/content/server-mdx-components';

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
      <header className="border-b border-[var(--md-outline-variant)] bg-[var(--md-surface)]">
        <div className="mx-auto max-w-4xl px-6 py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <Link
                href="/content"
                className="mb-1 inline-flex min-h-11 items-center text-sm font-semibold text-[var(--md-primary)] hover:underline"
              >
                ← Content
              </Link>
              <h1 className="text-xl font-bold text-[var(--md-on-surface)]">
                Week {weekNum}: {week.title}
              </h1>
              <p className="mt-0.5 text-sm text-[var(--md-on-surface-variant)]">
                {rotation.shortName}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/${rotationId}/week/${weekNum}/review`}
                className="btn btn-outlined btn-sm"
              >
                Quiz
              </Link>
              {week.prevWeek && (
                <Link
                  href={`/${rotationId}/week/${week.prevWeek}`}
                  className="btn btn-text btn-sm"
                >
                  ← Prev
                </Link>
              )}
              {week.nextWeek && (
                <Link
                  href={`/${rotationId}/week/${week.nextWeek}`}
                  className="btn btn-text btn-sm"
                >
                  Next →
                </Link>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-6 py-4">
        <div className="mb-6 flex flex-wrap gap-2">
          {week.topics.map((topic) => (
            <span
              key={topic}
              className="rounded-full bg-[var(--md-secondary-container)] px-3 py-1 text-sm font-medium text-[var(--md-on-secondary-container)]"
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

      <WeekContentWithTabs
        prevWeekHref={week.prevWeek ? `/${rotationId}/week/${week.prevWeek}` : null}
        nextWeekHref={week.nextWeek ? `/${rotationId}/week/${week.nextWeek}` : null}
      >
        {Content ? (
          <>
            {renderMdxContent(Content)}
            {SupplementaryContent && (
              <>
                <hr className="my-12 border-[var(--md-outline-variant)]" />
                {renderMdxContent(SupplementaryContent)}
              </>
            )}
            {CsdContent && (
              <>
                <hr className="my-12 border-[var(--md-outline-variant)]" />
                {renderMdxContent(CsdContent)}
              </>
            )}
          </>
        ) : (
          <div className="rounded-xl bg-[var(--md-surface-container)] p-8 text-center">
            <p className="mb-4 text-[var(--md-on-surface-variant)]">
              Content for Week {weekNum}: {week.title} is being prepared.
            </p>
            <p className="text-sm text-[var(--md-on-surface-variant)]">
              Check back soon for the full content.
            </p>
          </div>
        )}
      </WeekContentWithTabs>

      <nav className="mx-auto max-w-4xl border-t border-[var(--md-outline-variant)] px-6 py-8">
        <div className="flex justify-between gap-3">
          {week.prevWeek ? (
            <Link
              href={`/${rotationId}/week/${week.prevWeek}`}
              className="btn btn-outlined"
            >
              ← Week {week.prevWeek}: {getWeekMeta(rotationId, week.prevWeek)?.title}
            </Link>
          ) : (
            <div />
          )}
          {week.nextWeek ? (
            <Link
              href={`/${rotationId}/week/${week.nextWeek}`}
              className="btn btn-outlined"
            >
              Week {week.nextWeek}: {getWeekMeta(rotationId, week.nextWeek)?.title} →
            </Link>
          ) : (
            <Link href="/content" className="btn btn-outlined">
              Back to Content
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
