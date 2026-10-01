'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';

interface InlineMagicLinkProps {
  /** Compact = single row (for tight spaces), default = stacked */
  compact?: boolean;
}

export function InlineMagicLink({ compact }: InlineMagicLinkProps) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;

    setLoading(true);
    setError(null);
    try {
      const result = await signIn('email', { email, callbackUrl: '/', redirect: false });
      if (result?.error) {
        setError('Could not send link. Try again.');
        return;
      }
      setSent(true);
    } catch {
      setError('Could not send link. Try again.');
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <div className="text-center text-sm text-[var(--md-on-surface-variant)]">
        <p>Check <strong>{email}</strong> for a sign-in link.</p>
        <button
          onClick={() => { setSent(false); setEmail(''); }}
          className="text-[var(--md-primary)] hover:underline mt-1"
        >
          Use a different email
        </button>
      </div>
    );
  }

  if (compact) {
    return (
      <form onSubmit={handleSubmit} className="space-y-1">
        <div className="flex gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-[var(--md-outline)] bg-[var(--md-surface)] text-[var(--md-on-surface)] placeholder:text-[var(--md-on-surface-variant)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--md-primary)]"
            required
          />
          <button
            type="submit"
            disabled={loading || !email}
            className="px-3 py-2 rounded-lg bg-[var(--md-primary)] text-[var(--md-on-primary)] text-sm font-medium whitespace-nowrap disabled:opacity-50"
          >
            {loading ? 'Sending...' : 'Sign in'}
          </button>
        </div>
        {error && <p className="text-xs text-[var(--md-error)]">{error}</p>}
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        className="w-full px-3 py-2.5 rounded-xl border border-[var(--md-outline)] bg-[var(--md-surface)] text-[var(--md-on-surface)] placeholder:text-[var(--md-on-surface-variant)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--md-primary)]"
        required
      />
      <button
        type="submit"
        disabled={loading || !email}
        className="w-full py-2.5 rounded-xl bg-[var(--md-primary)] text-[var(--md-on-primary)] text-sm font-medium disabled:opacity-50"
      >
        {loading ? 'Sending...' : 'Send magic link'}
      </button>
      {error && <p className="text-xs text-[var(--md-error)] text-center">{error}</p>}
    </form>
  );
}
