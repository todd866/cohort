import {
  REVIEW_CALENDAR_SLOT_CLASS,
  TOPIC_READINESS_SLOT_CLASS,
} from './profile-slot-classes';

/**
 * Same order as the profile, and the same slot heights. Identity sits after
 * the study surfaces, so this must not lead with an avatar.
 */
export default function ProfileLoading() {
  const bar = 'animate-pulse rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)]';
  return (
    <div className="min-h-screen bg-[var(--md-surface)] py-8">
      <main className="mx-auto max-w-2xl px-4 lg:max-w-4xl">
        <div aria-hidden="true" className={`mb-6 ${TOPIC_READINESS_SLOT_CLASS} ${bar}`} />
        <div aria-hidden="true" className={`mb-6 ${REVIEW_CALENDAR_SLOT_CLASS} ${bar}`} />
        <div aria-hidden="true" className={`mb-4 h-11 ${bar}`} />
        <div aria-hidden="true" className={`mb-6 h-36 ${bar}`} />
        <div aria-hidden="true" className={`mb-4 h-24 ${bar}`} />
        <div className="grid gap-3 sm:grid-cols-2">
          <div aria-hidden="true" className={`h-16 ${bar}`} />
          <div aria-hidden="true" className={`h-16 ${bar}`} />
          <div aria-hidden="true" className={`h-16 ${bar}`} />
        </div>
        <div aria-hidden="true" className={`mt-6 h-16 ${bar}`} />
        <div aria-hidden="true" className={`mt-4 h-11 ${bar}`} />
        <div aria-hidden="true" className={`mt-6 h-40 ${bar}`} />
      </main>
    </div>
  );
}
