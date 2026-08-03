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
  const session = await auth();
  const src = props.image ?? props.imageUrl ?? null;
  const resolved = await resolveImage(src, session);
  return (
    <MCQClient
      {...(props as Record<string, unknown>)}
      imageUrl={resolved?.imageUrl ?? undefined}
      image={resolved?.imageUrl ?? props.image}
      imageKey={resolved?.imageKey ?? undefined}
      imageMeta={resolved?.imageMeta}
    />
  );
}
