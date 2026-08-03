import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import ProfilePageClient from './ProfilePageClient';
import { ProfileSignOutButton } from './ProfileSignOutButton';
import { toProfileIdentity } from './profile-identity';

export default async function ProfilePage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/auth/signin');

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      studyGoal: true,
      feedProfile: true,
    },
  });
  if (!user) redirect('/auth/signin');

  const initialProfile = toProfileIdentity(user);

  return (
    <div className="min-h-screen bg-[var(--md-surface)] py-8">
      <main className="mx-auto max-w-2xl px-4">
        <ProfilePageClient initialProfile={initialProfile} />

        <nav aria-label="Profile destinations" className="space-y-3">
          <ProfileDestination
            href="/profile/stats"
            title="Statistics"
            description="Review history, streaks and progress"
          />
          <ProfileDestination
            href="/profile/settings"
            title="Settings"
            description="Exam dates, appearance and institution"
          />
        </nav>

        <ProfileSignOutButton />
      </main>
    </div>
  );
}

function ProfileDestination({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="flex min-h-16 items-center justify-between gap-4 rounded-xl border border-[var(--md-outline-variant)] px-4 py-3 text-[var(--md-on-surface)] transition-colors hover:bg-[var(--md-surface-container-high)]"
    >
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs text-[var(--md-on-surface-variant)]">
          {description}
        </span>
      </span>
      <span aria-hidden="true" className="text-[var(--md-on-surface-variant)]">→</span>
    </Link>
  );
}
