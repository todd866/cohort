'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { getProviders, signIn } from 'next-auth/react';
import { Button } from '@/components/ui/Button';
import { useInteractionTracking } from '@/hooks/useTracking';
import { safeInternalCallback } from '@/lib/auth-callback';

const ERROR_MESSAGES: Record<string, string> = {
  Verification: 'That sign-in link has expired or was already used. Please request a new one.',
  AccessDenied: 'Access denied. Please try again or use a different sign-in method.',
  Configuration: 'There was a problem with the server. Please try again later.',
  Default: 'Something went wrong. Please try again.',
};

function SignInContent() {
  const searchParams = useSearchParams();
  const { trackInteraction } = useInteractionTracking();
  const [providers, setProviders] = useState<Record<string, { id: string; name: string }> | null>(null);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersFailed, setProvidersFailed] = useState(false);
  const [email, setEmail] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(() => {
    const error = searchParams.get('error');
    if (!error) return null;
    return ERROR_MESSAGES[error] || ERROR_MESSAGES.Default;
  });
  const source = searchParams.get('source') ?? 'signin-page';
  const callbackUrl = safeInternalCallback(searchParams.get('callbackUrl'));

  useEffect(() => {
    trackInteraction('AuthFunnel', 'signin_view', source);
  }, [source, trackInteraction]);

  useEffect(() => {
    let mounted = true;
    getProviders()
      .then((result) => {
        if (!mounted) return;
        // next-auth returns a map of providers; we only need id/name for UI gating.
        setProviders((result as Record<string, { id: string; name: string }>) || {});
      })
      .catch(() => {
        // If providers fetch fails, keep UI usable; errors will surface on sign-in attempt.
        if (!mounted) return;
        setProvidersFailed(true);
      })
      .finally(() => {
        if (!mounted) return;
        setProvidersLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;

    setLoading(true);
    setErrorMessage(null);
    trackInteraction('AuthFunnel', 'auth_start', source, { provider: 'email' });
    try {
      const result = await signIn('email', { email, callbackUrl, redirect: false });
      if (result?.error) {
        setErrorMessage('Could not send magic link. Please try again.');
        return;
      }
      setEmailSent(true);
    } catch (error) {
      console.error('Email sign in error:', error);
      setErrorMessage('Could not send magic link. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleProviderSignIn = (provider: 'google' | 'github') => {
    trackInteraction('AuthFunnel', 'auth_start', source, { provider });
    void signIn(provider, { callbackUrl });
  };

  const emailEnabled = providersLoading ? true : providers ? Boolean(providers.email) : true;
  const googleEnabled = Boolean(providers?.google);
  const githubEnabled = Boolean(providers?.github);

  if (emailSent) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="max-w-sm w-full text-center">
          <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-[var(--md-primary-container)] flex items-center justify-center">
            <svg
              className="w-8 h-8 text-[var(--md-primary)]"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-[var(--md-on-surface)] mb-2">
            Check your email
          </h1>
          <p className="text-[var(--md-on-surface-variant)] mb-4">
            We sent a magic link to <strong>{email}</strong>
          </p>
          <p className="text-sm text-[var(--md-on-surface-variant)]">
            Click the link in the email to sign in. The link expires in 24 hours.
          </p>
          <p className="text-sm text-[var(--md-on-surface-variant)] mt-2">
            <strong>On your phone?</strong> Make sure the link opens in Safari or Chrome, not your email app.
          </p>
          <button
            onClick={() => setEmailSent(false)}
            className="mt-6 text-sm text-[var(--md-primary)] hover:underline"
          >
            Use a different email
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-sm w-full">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-[var(--md-on-surface)] mb-2">
            Sign in to MD3
          </h1>
          <p className="text-[var(--md-on-surface-variant)]">
            Track your progress and sync across devices
          </p>
        </div>

        {errorMessage && (
          <div className="mb-6 p-4 rounded-xl bg-[var(--md-error-container)] text-[var(--md-on-error-container)] text-sm">
            {errorMessage}
          </div>
        )}

        {/* Email Magic Link */}
        <form onSubmit={handleEmailSignIn} className="mb-6">
          <label
            htmlFor="email"
            className="block text-sm font-medium text-[var(--md-on-surface)] mb-2"
          >
            Email address
          </label>
          <input
            type="email"
            id="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full px-4 py-3 rounded-xl border border-[var(--md-outline)] bg-[var(--md-surface)] text-[var(--md-on-surface)] placeholder:text-[var(--md-on-surface-variant)] focus:outline-none focus:ring-2 focus:ring-[var(--md-primary)] focus:border-transparent"
            required
            disabled={!emailEnabled}
          />
          <Button
            type="submit"
            variant="filled"
            className="w-full mt-3 justify-center"
            disabled={loading || !email || !emailEnabled}
          >
            {!emailEnabled
              ? 'Email sign-in unavailable'
              : loading
                ? 'Sending...'
                : 'Send magic link'}
          </Button>
          {providersFailed && (
            <p className="mt-3 text-xs text-[var(--md-on-surface-variant)]">
              Couldn&apos;t load sign-in providers. You can still try email sign-in.
            </p>
          )}
        </form>

        <div className="relative mb-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-[var(--md-outline)]"></div>
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="px-4 bg-[var(--md-surface)] text-[var(--md-on-surface-variant)]">
              or continue with
            </span>
          </div>
        </div>

        <div className="space-y-3">
          {googleEnabled && (
            <Button
              variant="outlined"
              className="w-full justify-center gap-3"
              onClick={() => handleProviderSignIn('google')}
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path
                  fill="currentColor"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="currentColor"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="currentColor"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="currentColor"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
              Google
            </Button>
          )}

          {githubEnabled && (
            <Button
              variant="outlined"
              className="w-full justify-center gap-3"
              onClick={() => handleProviderSignIn('github')}
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              GitHub
            </Button>
          )}
        </div>

        <p className="mt-8 text-center text-sm text-[var(--md-on-surface-variant)]">
          Your progress is private and only visible to you.
        </p>
      </div>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center px-6">
          <p className="text-[var(--md-on-surface-variant)]">Loading...</p>
        </div>
      }
    >
      <SignInContent />
    </Suspense>
  );
}
