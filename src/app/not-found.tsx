import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 text-center">
      <div className="max-w-md space-y-4">
        <h2 className="text-xl font-semibold text-[var(--md-on-surface)]">
          Page not found
        </h2>
        <p className="text-sm text-[var(--md-on-surface-variant)]">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <Link
          href="/"
          className="inline-block px-4 py-2 rounded-full text-sm font-medium bg-[var(--md-primary)] text-[var(--md-on-primary)]"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
