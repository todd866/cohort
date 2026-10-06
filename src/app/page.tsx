import { Suspense } from 'react';
import { PublicReviewEntry } from '@/components/cohort/PublicReviewEntry';

export default function ReviewPage() {
  return <Suspense fallback={<p role="status" className="p-6">Preparing review…</p>}><PublicReviewEntry /></Suspense>;
}
