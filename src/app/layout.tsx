import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Analytics } from "@vercel/analytics/next";
import localFont from "next/font/local";
import "./globals.css";
import "katex/dist/katex.min.css";
import { sessionPreloadBootstrap } from "@/lib/review/session-preload";
import { swRegistrationBootstrap } from "@/lib/offline/sw-registration";
import { Providers } from "@/components/Providers";
import { AppShell } from "@/components/AppShell";
import { OfflineShellWarm } from "@/components/OfflineShellWarm";
import { buildWebManifest } from "@/lib/offline/manifest";
import { detectInstitutionFromHostname } from "@/lib/institution";
import { isVercelAnalyticsEnabled } from "@/lib/analytics-config";

/**
 * Self-hosted instead of `geist/font/*`, and deliberately NOT preloaded.
 *
 * Vercel appends a deployment id to every asset. Next preloaded the font at the
 * CURRENT deployment id, while the `@font-face` inside the CSS still carried the
 * PREVIOUS one (an unchanged CSS chunk restored from Next's build cache keeps
 * its baked-in `?dpl`). Two URLs, identical bytes: Chrome downloaded both and
 * warned "preloaded using link preload but not used" — 137.7 KB wasted on every
 * cold load, 18% of the page's transfer.
 *
 * Owning the files removes the mismatch. `preload: false` means the font is
 * discovered when the (render-blocking) CSS parses, which costs nothing here,
 * and only one copy is ever fetched. `adjustFontFallback` keeps a metric-matched
 * fallback so the swap does not shift layout — CLS must stay 0.
 */
const geistSans = localFont({
  src: "./fonts/Geist-Variable.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
  preload: false,
  adjustFontFallback: "Arial",
});

const geistMono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
  preload: false,
  adjustFontFallback: "Arial",
});

export async function generateMetadata(): Promise<Metadata> {
  const headersList = await headers();
  const host = headersList.get("host") ?? "";
  const institution = detectInstitutionFromHostname(host);

  const isCohort = institution === "usmle";
  const title = isCohort ? "cohort.md" : "MD3";
  const description = isCohort
    ? "Free USMLE Step 1 prep — spaced repetition, clinical vignettes, and video content"
    : "Clinical learning platform for medical students";

  return {
    title,
    description,
    keywords: isCohort
      ? ["USMLE", "Step 1", "medical education", "spaced repetition", "USMLE prep", "clinical vignettes"]
      : ["medicine", "medical school", "clinical rotations", "spaced repetition", "medical education"],
    openGraph: { title, description, type: "website" },
    // Installable to the homescreen. The manifest is a route handler rather than
    // Next's static `app/manifest.ts` because one deployment answers for two
    // brands and an installed app keeps the name it was installed with.
    manifest: "/manifest.webmanifest",
    appleWebApp: { capable: true, title, statusBarStyle: "default" },
    icons: {
      // iOS ignores the manifest for Add to Home Screen and reads this instead.
      apple: isCohort ? "/icons/cohort-apple-touch.png" : "/icons/md3-apple-touch.png",
    },
  };
}

export async function generateViewport(): Promise<Viewport> {
  const headersList = await headers();
  // Read the brand colour from the manifest builder rather than repeating the
  // literal: an installed app's theme colour and its manifest disagreeing would
  // show as a seam between the splash screen and the status bar.
  const { theme_color } = buildWebManifest(headersList.get("host") ?? "");
  return {
    themeColor: theme_color,
    // The installed app runs without browser chrome, so the status bar area is
    // ours to paint.
    viewportFit: "cover",
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const headersList = await headers();
  const isCohortHost = detectInstitutionFromHostname(headersList.get("host") ?? "") === "usmle";

  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable}`}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                const theme = localStorage.getItem('theme');
                if (theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
                  document.documentElement.classList.add('dark');
                }
              } catch (e) {}
            `,
          }}
        />
        {/*
          One-release cleanup for the retired session preload. The old head
          request could write ServeDecision/exposure rows even when React later
          rejected its response. This script only removes legacy browser state.
        */}
        <script dangerouslySetInnerHTML={{ __html: sessionPreloadBootstrap() }} />
        <script
          dangerouslySetInnerHTML={{ __html:
            process.env.NODE_ENV === 'production'
              ? swRegistrationBootstrap()
              : "if('serviceWorker' in navigator){navigator.serviceWorker.getRegistrations().then(function(r){r.forEach(function(reg){reg.unregister()})})}"
          }}
        />
      </head>
      <body
        className="antialiased min-h-screen"
      >
        <Providers>
          <AppShell isCohortHost={isCohortHost}>{children}</AppShell>
          {/* Inside Providers: it reads the session to bind the offline pack to
              an account, and useSession outside the provider is undefined. */}
          <OfflineShellWarm />
        </Providers>
        {isVercelAnalyticsEnabled() ? <Analytics /> : null}
      </body>
    </html>
  );
}
