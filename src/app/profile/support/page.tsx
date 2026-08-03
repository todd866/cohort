import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { SupportSection } from '../profile-support';

export const metadata: Metadata = {
  title: 'Feedback - MD3',
  description: 'Send feedback about MD3.',
};

export default async function ProfileSupportPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/auth/signin');

  return (
    <div className="min-h-screen bg-[var(--md-surface)] py-8">
      <main className="mx-auto max-w-2xl px-4">
        <Link
          href="/profile/settings"
          className="text-sm text-[var(--md-on-surface-variant)] hover:underline"
        >
          ← Settings
        </Link>
        <h1 className="mb-6 mt-3 text-2xl font-bold text-[var(--md-on-surface)]">
          Feedback
        </h1>
        <SupportSection />
      </main>
    </div>
  );
}
