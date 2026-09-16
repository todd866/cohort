import { redirect } from 'next/navigation';

/** Compatibility route for public builds that do not ship a personal dossier. */
export default function BriefRedirect() {
  redirect('/profile');
}
