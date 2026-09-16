'use client';

import { deepDiveMetaBySlug } from '@/lib/deep-dives';
import { DeepDive } from '@/components/content/DeepDive';

interface DeepDiveLinkProps {
  slug: string;
  title?: string;
  description?: string;
  duration?: string;
  hasVideo?: boolean;
}

export function DeepDiveLink({ slug, title, description, duration, hasVideo }: DeepDiveLinkProps) {
  const meta = deepDiveMetaBySlug[slug];
  const href = `/deep-dive/${slug}`;

  return (
    <DeepDive
      href={href}
      title={title || meta?.title || 'Deep Dive'}
      description={description || meta?.description || 'Open supplementary notes.'}
      duration={duration || meta?.duration}
      hasVideo={hasVideo ?? meta?.hasVideo}
      id={slug}
    />
  );
}

