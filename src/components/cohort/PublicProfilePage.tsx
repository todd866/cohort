import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { ProfileFrame } from '@/components/shared/ProfileFrame';
import { ProfileDestination } from '@/components/shared/ProfileDestination';
import ProfilePageClient from '@/app/profile/ProfilePageClient';
import { ProfileSignOutButton } from '@/app/profile/ProfileSignOutButton';
import { toProfileIdentity } from '@/app/profile/profile-identity';

export default async function PublicProfilePage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/auth/signin');
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { id: true, name: true, email: true, image: true, studyGoal: true, feedProfile: true } });
  if (!user) redirect('/auth/signin');
  return <ProfileFrame><ProfilePageClient initialProfile={toProfileIdentity(user)} /><nav aria-label="Profile destinations" className="mt-6 space-y-3"><ProfileDestination href="/profile/stats" title="Statistics" description="Review history, streaks and progress" /><ProfileDestination href="/profile/settings" title="Settings" description="Exam dates, appearance and institution" /><ProfileDestination href="/tech" title="How it’s built" description="The method, the numbers, and the source" /></nav><ProfileSignOutButton /></ProfileFrame>;
}
