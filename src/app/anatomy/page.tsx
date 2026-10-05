import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { isCohortHostname } from '@/lib/institution';
import AnatomyStudyClient from './AnatomyStudyClient';

export const metadata: Metadata = {
  title: 'Anatomy study — cohort.md',
  description: 'Open anatomy study with reviewed explanations and released scaffolding cards.',
};

/**
 * Anatomy is a Cohort-only public module. The fixed topic is passed into the
 * existing Cohort single-turn reviewer, so the server owns the released
 * question/card scope and this page never changes learner module preferences.
 */
export default async function AnatomyPage() {
  const host = (await headers()).get('host') ?? '';
  if (!isCohortHostname(host)) notFound();

  return <AnatomyStudyClient />;
}
