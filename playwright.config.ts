import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E configuration for MD3.
 *
 * ONE suite, env-driven, three targets:
 *
 *   1. Dev      — `npm run e2e`        → spins up `next dev`, localhost.
 *   2. CI gate  — `npm run e2e:ci`     → runs the @prod-safe suite against a real
 *                                        production build (`next start`), every
 *                                        push. Catches prod-build + visual
 *                                        regressions that `next dev` hides.
 *   3. Live     — `npm run e2e:prod`   → runs the @prod-safe subset against a
 *                                        live URL (md3.info or a preview),
 *                                        no local server. Post-deploy + cron.
 *
 * Target selection is purely via PLAYWRIGHT_BASE_URL:
 *   - unset            → start a local server (dev or prod build, see below)
 *   - set to a URL     → hit that URL, start NO local server
 *
 * Prod-safety: only specs tagged `@prod-safe` may run against a live site.
 * They are read-only (GET public pages) or fully mock their API calls via
 * page.route — they never write to or authenticate against real prod data.
 * Remote targets also enforce this filter in config, so an accidental plain
 * `playwright test` cannot select local/data-touching specs against a live URL.
 */

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000';
const isRemoteTarget = !!process.env.PLAYWRIGHT_BASE_URL;

// In CI without a remote target we serve a real production build; locally we
// use the dev server for fast iteration. `npm run build` must have run first
// when CI serves the prod build (the CI job does this).
const localServerCommand = process.env.CI
  ? 'npm run start -- -p 3000'
  : 'next dev --webpack -H 127.0.0.1 -p 3000';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'html',
  // Defense in depth: e2e:prod passes --grep too, but the target URL itself is
  // enough to force the safe subset even when someone invokes Playwright by hand.
  grep: isRemoteTarget ? /@prod-safe/ : undefined,

  use: {
    baseURL,
    // Fixture-backed specs intercept every app API call. Blocking service
    // workers ensures an installed production worker cannot bypass page.route
    // and turn a hermetic/prod-safe test into a real data request.
    serviceWorkers: 'block',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 375, height: 667 },
      },
    },
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],

  // No local server when pointed at a live URL — we test what's deployed.
  webServer: isRemoteTarget
    ? undefined
    : {
        command: localServerCommand,
        url: 'http://localhost:3000',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
