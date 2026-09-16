import 'server-only';
import { auth } from '@/lib/auth';
import { resolveImage } from '@/lib/figures/resolve';
import { MCQClient } from './MCQ.client';

// Mirror the public prop interface from MCQ.client.tsx (read it first).
// Use a permissive index signature to forward unknown props.
interface MCQServerProps {
  image?: string;
  imageUrl?: string;
  [k: string]: unknown;
}

export async function MCQ(props: MCQServerProps) {
  const src = props.image ?? props.imageUrl ?? null;

  // Only stored figure keys need the authenticated resolver. Static MCQs
  // without media — and author-supplied external URLs — should retain their
  // existing rendering path without making an otherwise static MDX page
  // dynamic just to read a session.
  if (!src || !src.startsWith('/figures/')) {
    return <MCQClient {...(props as Record<string, unknown>)} />;
  }

  const session = await auth();
  const resolved = await resolveImage(src, session);
  return (
    <MCQClient
      {...(props as Record<string, unknown>)}
      imageUrl={resolved?.imageUrl ?? undefined}
      // Fail closed for internal figure keys. Forwarding props.image when the
      // resolver declined it bypassed both the entitlement check and sensitive
      // sidecar projection in server-rendered MDX.
      image={resolved?.imageUrl ?? undefined}
      imageKey={resolved?.imageKey ?? undefined}
      imageMeta={resolved?.imageMeta}
    />
  );
}
