import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { ROTATIONS } from '@/lib/rotations';
import ProfileSettingsClient, { type SettingsRotation } from './ProfileSettingsClient';

export const metadata: Metadata = {
  title: 'Settings - MD3',
  description: 'Manage study dates, appearance and account preferences.',
};

export default async function ProfileSettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/auth/signin');

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      email: true,
      jurisdiction: true,
      rotations: {
        select: {
          rotation: true,
          examDate: true,
        },
      },
    },
  });
  if (!user) redirect('/auth/signin');

  const examDates = new Map(user.rotations.map((rotation) => [
    rotation.rotation,
    rotation.examDate,
  ]));
  const rotations: SettingsRotation[] = ROTATIONS.map((rotation) => ({
    id: rotation.id,
    shortName: rotation.shortName,
    examDate: (examDates.get(rotation.id) ?? rotation.defaultExamDate)
      .toISOString()
      .slice(0, 10),
  }));

  return (
    <div className="min-h-screen bg-[var(--md-surface)] py-8">
      <main className="mx-auto max-w-2xl px-4">
        <Link
          href="/profile"
          className="text-sm text-[var(--md-on-surface-variant)] hover:underline"
        >
          ← Profile
        </Link>
        <h1 className="mb-6 mt-3 text-2xl font-bold text-[var(--md-on-surface)]">
          Settings
        </h1>

        <ProfileSettingsClient
          primaryEmail={user.email}
          initialJurisdiction={user.jurisdiction}
          rotations={rotations}
        />
      </main>
    </div>
  );
}
