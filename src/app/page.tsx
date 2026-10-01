import Link from 'next/link';

/** The open products cohort.md serves. Order is deliberate: most complete first. */
const COHORT_PRODUCTS = [
  {
    href: '/gamsat',
    name: 'GAMSAT',
    blurb: 'Reasoning practice that names the move behind every question.',
    detail: '11 passages \u00b7 77 questions \u00b7 Sections I and III',
  },
  {
    href: '/usmle',
    name: 'USMLE Step 1',
    blurb: 'Open Step 1 MCQs with a source trail after every answer.',
    detail: 'Early open corpus',
  },
];

export default function HomePage() {
  return (
    <main className="mx-auto max-w-xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight text-[var(--md-on-surface)]">
        cohort.md
      </h1>
      <p className="mt-3 text-[var(--md-on-surface-variant)]">
        Free and open exam preparation. Every question is originally authored and
        openly licensed. No score or pass prediction.
      </p>

      <ul className="mt-10 space-y-3">
        {COHORT_PRODUCTS.map((product) => (
          <li key={product.href}>
            <Link
              href={product.href}
              className="block rounded-2xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] p-5 transition-colors hover:border-[var(--md-primary)]"
            >
              <p className="text-lg font-semibold text-[var(--md-on-surface)]">
                {product.name}
              </p>
              <p className="mt-1 text-sm text-[var(--md-on-surface-variant)]">
                {product.blurb}
              </p>
              <p className="mt-2 text-xs text-[var(--md-on-surface-variant)]">
                {product.detail}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
