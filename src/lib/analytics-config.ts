export interface AnalyticsEnvironment {
  NEXT_PUBLIC_ENABLE_VERCEL_ANALYTICS?: string;
}

/** Optional third-party analytics stays off unless the operator opts in. */
export function isVercelAnalyticsEnabled(
  env: AnalyticsEnvironment = process.env as AnalyticsEnvironment,
): boolean {
  return env.NEXT_PUBLIC_ENABLE_VERCEL_ANALYTICS?.trim().toLowerCase() === 'true';
}

export interface VercelAnalyticsCspSources {
  script: readonly string[];
  connect: readonly string[];
}

/** Keep CSP third-party allowances aligned with the same explicit opt-in. */
export function vercelAnalyticsCspSources(
  enabled: boolean = isVercelAnalyticsEnabled(),
): VercelAnalyticsCspSources {
  return enabled
    ? {
        script: ['https://va.vercel-scripts.com'],
        connect: [
          'https://va.vercel-scripts.com',
          'https://vitals.vercel-insights.com',
        ],
      }
    : { script: [], connect: [] };
}
