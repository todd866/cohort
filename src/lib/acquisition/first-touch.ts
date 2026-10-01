/**
 * Where a learner first came from: the referring site's host, any UTM tags on
 * the link they followed, and the page they landed on. Captured once in the
 * browser on first visit and stored once per learner, so the owner can tell a
 * Threads visitor from a USyd student arriving from Canvas.
 *
 * Deliberately coarse. Only the referrer's HOST is kept: a full referring URL
 * can carry tokens (Threads' link shim does). The landing path keeps no query
 * string beyond the UTM tags. Nothing here identifies a person.
 */

export interface FirstTouch {
  landingPath: string;
  referrerHost?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  at: string;
}

const OWN_HOSTS = /(^|\.)(md3\.info|cohort\.md|localhost)$/;
const MAX_TAG = 60;
const MAX_PATH = 200;

function tag(value: string | null): string | undefined {
  const cleaned = value?.trim().toLowerCase().slice(0, MAX_TAG);
  return cleaned ? cleaned : undefined;
}

function hostOf(referrer: string): string | undefined {
  try {
    const host = new URL(referrer).hostname.toLowerCase();
    return host && !OWN_HOSTS.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

export function parseFirstTouch(href: string, referrer: string, at: string): FirstTouch {
  const url = new URL(href);
  const touch: FirstTouch = { landingPath: url.pathname.slice(0, MAX_PATH) || '/', at };
  const referrerHost = hostOf(referrer);
  if (referrerHost) touch.referrerHost = referrerHost;
  const source = tag(url.searchParams.get('utm_source'));
  const medium = tag(url.searchParams.get('utm_medium'));
  const campaign = tag(url.searchParams.get('utm_campaign'));
  if (source) touch.utmSource = source;
  if (medium) touch.utmMedium = medium;
  if (campaign) touch.utmCampaign = campaign;
  return touch;
}
