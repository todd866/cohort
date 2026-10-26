/**
 * An installed app's window already carries its name: Chrome titles the
 * window "md3 - <page title>". Page titles end in the brand for browser tabs
 * ("Profile - md3"), so the window read "md3 - Profile - md3" (owner,
 * 2026-10-22: "kinda dumb"). In standalone display mode the brand suffix comes
 * off; in a tab it stays.
 */
export function stripBrandSuffix(title: string, brand: string): string {
  const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = title.replace(new RegExp(`\\s*[-|·–—]\\s*${escaped}\\s*$`), '').trim();
  return stripped.length > 0 ? stripped : title;
}
