import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Profile - MD3',
  description: 'View your study stats, streaks, and account settings.',
};

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return children;
}
