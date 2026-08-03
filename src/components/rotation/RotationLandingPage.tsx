import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { getRotation } from '@/lib/rotation-metadata';
import { buildReviewHref } from '@/lib/review/review-intent';

interface RotationLandingPageProps {
  rotationId: string;
}

export function RotationLandingPage({ rotationId }: RotationLandingPageProps) {
  const rotation = getRotation(rotationId);
  if (!rotation) return null;

  const weeks = Object.entries(rotation.weeks).map(([num, week]) => ({
    num: parseInt(num),
    ...week,
  }));

  return (
    <div className="min-h-screen px-6 py-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className={`w-12 h-12 rounded-xl ${rotation.bgClass} flex items-center justify-center text-2xl`}>
              {rotation.emoji}
            </div>
            <div>
              <h1 className="text-3xl font-bold text-[var(--md-on-surface)]">
                {rotation.name}
              </h1>
              <p className="text-[var(--md-on-surface-variant)]">
                {weeks.length} weeks
              </p>
            </div>
          </div>
        </div>

        {/* Start Review CTA */}
        <div className="mb-8">
          <Link
            href={buildReviewHref({ rotation: rotationId })}
            className="block p-5 rounded-xl bg-[var(--md-primary)] text-[var(--md-on-primary)] text-center font-medium text-lg hover:opacity-90 transition-opacity"
          >
            Start Review
          </Link>
        </div>

        {/* Sub-Rotation Pages */}
        {rotation.subrotations.length > 0 && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold text-[var(--md-on-surface)] mb-4">
              Specialty Reference Guides
            </h2>
            <div className={`grid grid-cols-1 gap-4 ${rotation.subrotationGridCols === 2 ? 'md:grid-cols-2' : rotation.subrotationGridCols === 4 ? 'md:grid-cols-4' : 'md:grid-cols-3'}`}>
              {rotation.subrotations.map((sub) => (
                <Link key={sub.slug} href={`/${rotationId}/${sub.slug}`}>
                  <Card
                    variant="filled"
                    className={`p-4 h-full hover:shadow-md transition-shadow cursor-pointer ${sub.cardColor}`}
                  >
                    <div className="flex items-start gap-3">
                      <span className="text-2xl">{sub.emoji}</span>
                      <div>
                        <h3 className="font-semibold text-[var(--md-on-surface)]">{sub.title}</h3>
                        <p className="text-sm text-[var(--md-on-surface-variant)] mt-1">
                          {sub.description}
                        </p>
                      </div>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Week List */}
        <div className="space-y-4">
          {weeks.map((week) => (
            <Link key={week.num} href={`/${rotationId}/week/${week.num}`}>
              <Card
                variant="outlined"
                className="p-4 hover:bg-[var(--md-surface-container-high)] transition-colors cursor-pointer"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-[var(--md-primary)]">
                        Week {week.num}
                      </span>
                    </div>
                    <h3 className="text-lg font-semibold text-[var(--md-on-surface)] mb-2">
                      {week.title}
                    </h3>
                    <div className="flex flex-wrap gap-1">
                      {week.topics.slice(0, 4).map((topic) => (
                        <span
                          key={topic}
                          className="px-2 py-0.5 text-xs rounded-full bg-[var(--md-surface-container-highest)] text-[var(--md-on-surface-variant)]"
                        >
                          {topic}
                        </span>
                      ))}
                      {week.topics.length > 4 && (
                        <span className="px-2 py-0.5 text-xs text-[var(--md-on-surface-variant)]">
                          +{week.topics.length - 4} more
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="text-[var(--md-on-surface-variant)]">&rarr;</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>

        {/* Extra Sections (e.g. Skills Practice for CC) */}
        {rotation.extraSections?.map((section) => (
          <div key={section.href} className="mt-8 pt-6 border-t border-[var(--md-outline-variant)]">
            <Link
              href={section.href}
              className={`block p-4 rounded-lg ${section.className} transition-colors`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-blue-600 dark:text-blue-400">{section.title}</div>
                  <div className="text-xs text-[var(--md-on-surface-variant)]">{section.subtitle}</div>
                </div>
                <span className="text-2xl">{section.emoji}</span>
              </div>
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
