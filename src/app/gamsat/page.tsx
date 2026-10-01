import type { Metadata } from 'next';
import GamsatSessionClient from './GamsatSessionClient';

export const metadata: Metadata = {
  title: 'GAMSAT reasoning practice',
  description:
    'Free and open GAMSAT practice that names the reasoning move behind every question. '
    + 'Originally authored passages, CC BY 4.0.',
};

/**
 * `/gamsat` is a session, not a landing page: it renders straight into the first
 * passage. No splash, no feature tour, no signup wall — someone who came to
 * prepare should be preparing. The FOSS note lives in the footer.
 */
export default function GamsatPage() {
  return <GamsatSessionClient />;
}
