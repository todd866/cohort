import Link from 'next/link';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { statsSurfacesForHost } from '@/lib/stats/stats-surfaces';
import type { Metadata } from 'next';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { loadStatsPage } from '@/lib/stats/stats-page.server';
import { parsePeriod } from '@/lib/stats/stats-model';
import type { StatsDb } from '@/lib/stats/stats-query.server';
import { StatsDashboard } from '@/components/stats/StatsDashboard';
import { RefreshOnReturn } from '@/components/profile/RefreshOnReturn';

export const metadata: Metadata = {
  title: 'Statistics',
  robots: { index: false, follow: false },
};

const ROTATION_PARAM = /^[a-z0-9-]{1,40}$/;

export default async function StatsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/auth/signin');

  const params = await searchParams;
  const rotationParam = typeof params.rotation === 'string' && ROTATION_PARAM.test(params.rotation) ? params.rotation : null;
  const data = await loadStatsPage(prisma as unknown as StatsDb, session.user.id, {
    period: parsePeriod(params.period),
    rotation: rotationParam,
    now: new Date(),
  });

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 pb-28 md:pb-10">
      <RefreshOnReturn />
      <header className="mb-4">
        <Link href="/profile" className="text-xs text-[var(--md-on-surface-variant)] hover:underline">
          ← Profile
        </Link>
        <h1 className="mt-3 text-[1.75rem] font-bold leading-tight tracking-tight text-[var(--md-on-surface)]">
          Statistics
        </h1>
      </header>

      {data.hasHistory ? (
        <StatsDashboard data={data} surfaces={statsSurfacesForHost((await headers()).get('host') ?? '')} />
      ) : (
        <p className="text-sm text-[var(--md-on-surface-variant)]">
          Nothing to show yet — answer some cards and this fills in.
        </p>
      )}
    </main>
  );
}
