export { isAdminEmail } from './admin-shared';

/**
 * Server-side admin gate. Call at the top of any server component
 * (page or layout) to restrict access to admin users only.
 * Non-admins get a 404 — the route doesn't exist for them.
 */
export async function adminGate(): Promise<void> {
  const { auth } = await import('@/lib/auth');
  const { notFound } = await import('next/navigation');
  const { isAdminEmail } = await import('./admin-shared');
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) {
    notFound();
  }
}
