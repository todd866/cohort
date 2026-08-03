import 'server-only';
import { auth } from '@/lib/auth';
import { resolveImage } from '@/lib/figures/resolve';
import { FigureClient } from './Figure.client';
import type { OcclusionRegion } from './ImageOcclusion';

interface FigureServerProps {
  src: string;
  alt: string;
  caption?: string;
  source?: string;
  href?: string;
  id?: string;
  occlusions?: OcclusionRegion[];
  occlude?: 'all' | 'random';
  occludeCount?: number;
}

export async function Figure(props: FigureServerProps) {
  const session = await auth();
  const resolved = await resolveImage(props.src, session);
  if (!resolved) {
    // Locked tier or missing sidecar — render nothing
    return null;
  }
  return (
    <FigureClient
      {...props}
      src={resolved.imageUrl}
      imageKey={resolved.imageKey}
      meta={resolved.imageMeta}
    />
  );
}
