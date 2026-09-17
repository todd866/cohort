import Link from 'next/link';

export interface ReviewClusterScope {
  /** The manifold cluster id the session is restricted to. */
  id: string;
  /** Tidied display name for that cluster. Not unique — see below. */
  label: string;
  /** Live cards the cluster holds in this rotation. */
  cardCount: number;
  rotation: string | null;
}

/**
 * Says, on the review surface itself, that this is a scoped session — and how
 * to leave it.
 *
 * Reported 2026-09-17: clicking a topic square delivered a correctly scoped
 * session and looked identical to ordinary review. The cluster was threaded
 * through to the fetch and rendered nowhere, so the only way to know which
 * session you were in was to recognise the subject matter of the cards. When
 * the topic is one you are weak at, that is exactly the recognition you do not
 * have.
 *
 * The card COUNT is not decoration. Cluster labels are auto-derived from member
 * topics and are not unique: measured on CAH, 107 clusters carry only 64
 * distinct labels, 60 squares share a name with another square, and 54% of
 * cards sit under an ambiguous one. "Surgery" names seven different squares. So
 * the label alone cannot identify which scope you are in and the size is what
 * distinguishes them. That is a reason to fix the clustering, and until it is
 * fixed this banner must not pretend the name is precise.
 *
 * No animation: the review loop is a high-frequency surface, where the house
 * rule is that entrance motion on content the learner is reading is a defect
 * rather than a flourish.
 */
export function ReviewScopeBanner({ scope }: { scope: ReviewClusterScope | null }) {
  if (!scope) return null;
  const exitHref = scope.rotation ? `/?rotation=${encodeURIComponent(scope.rotation)}` : '/';
  const cards = `${scope.cardCount} ${scope.cardCount === 1 ? 'card' : 'cards'}`;

  return (
    <div
      role="status"
      className="mx-auto mb-3 flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] px-4 py-2"
    >
      <p className="text-sm text-[var(--md-on-surface)]">
        <span className="text-[var(--md-on-surface-variant)]">Topic review — </span>
        <span className="font-medium">{scope.label}</span>
        <span className="text-[var(--md-on-surface-variant)]">{` · ${cards}`}</span>
      </p>
      <Link
        href={exitHref}
        className="text-sm text-[var(--md-primary)] underline-offset-2 hover:underline"
      >
        Leave this topic
      </Link>
    </div>
  );
}
