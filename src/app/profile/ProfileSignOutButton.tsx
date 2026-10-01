'use client';

import { useState } from 'react';
import { signOut } from 'next-auth/react';
import { clearOfflineUserData } from '@/lib/offline/device-state';

export function ProfileSignOutButton() {
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);

  return (
    <div className="mt-8">
      <button
        type="button"
        disabled={signingOut}
        onClick={async () => {
          if (signingOut) return;
          setSigningOut(true);
          setSignOutError(false);
          try {
            await clearOfflineUserData();
            await signOut({ callbackUrl: '/' });
          } catch {
            setSignOutError(true);
          } finally {
            setSigningOut(false);
          }
        }}
        className="w-full rounded-xl border border-[var(--md-outline-variant)] px-4 py-3 text-sm font-medium text-[var(--md-error)] transition-colors hover:bg-[var(--md-error-container)] disabled:opacity-60"
      >
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>
      {signOutError ? (
        <p role="alert" className="mt-2 text-center text-xs text-[var(--md-error)]">
          Could not sign out. Try again.
        </p>
      ) : null}
    </div>
  );
}
