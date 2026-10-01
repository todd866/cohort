import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { auth } from '@/lib/auth';
import { loadReviewStats } from '@/lib/review-stats-query';
import { ReviewStats } from '@/components/stats/ReviewStats';

export const metadata: Metadata = {
  title: 'Statistics',
  robots: { index: false, follow: false },
};

export default async function StatsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/auth/signin');

  const stats = await loadReviewStats(session.user.id);

  return (
    <main className="mx-auto max-w-3xl px-5 py-6 pb-28 md:pb-10">
      <header className="mb-7">
        <Link
          href="/profile"
          className="text-xs text-[var(--md-on-surface-variant)] hover:underline"
        >
          ← Profile
        </Link>
        <h1 className="mt-3 text-[1.75rem] leading-tight font-bold tracking-tight text-[var(--md-on-surface)]">
          Statistics
        </h1>
      </header>

      {stats ? (
        <ReviewStats
          summary={stats.summary}
          heatmap={stats.heatmap}
          daily={stats.daily}
          maturity={stats.maturity}
          accuracyPct={stats.accuracyPct}
          reviewsDetached={stats.reviewsDetached}
          periodLabel={stats.periodLabel}
        />
      ) : (
        <p className="text-sm text-[var(--md-on-surface-variant)]">
          Nothing to show yet — answer some cards and this fills in.
        </p>
      )}
    </main>
  );
}
