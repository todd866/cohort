import { describe, expect, it } from 'vitest';
import {
  isVercelAnalyticsEnabled,
  vercelAnalyticsCspSources,
} from './analytics-config';

describe('isVercelAnalyticsEnabled', () => {
  it('is disabled by default and for non-affirmative values', () => {
    expect(isVercelAnalyticsEnabled({})).toBe(false);
    expect(isVercelAnalyticsEnabled({ NEXT_PUBLIC_ENABLE_VERCEL_ANALYTICS: '' })).toBe(false);
    expect(isVercelAnalyticsEnabled({ NEXT_PUBLIC_ENABLE_VERCEL_ANALYTICS: 'false' })).toBe(false);
    expect(isVercelAnalyticsEnabled({ NEXT_PUBLIC_ENABLE_VERCEL_ANALYTICS: '1' })).toBe(false);
  });

  it('requires an explicit true value', () => {
    expect(isVercelAnalyticsEnabled({
      NEXT_PUBLIC_ENABLE_VERCEL_ANALYTICS: ' true ',
    })).toBe(true);
  });

  it('adds no analytics CSP hosts while analytics is disabled', () => {
    expect(vercelAnalyticsCspSources(false)).toEqual({ script: [], connect: [] });
  });

  it('adds the exact script and connection hosts only after opt-in', () => {
    expect(vercelAnalyticsCspSources(true)).toEqual({
      script: ['https://va.vercel-scripts.com'],
      connect: [
        'https://va.vercel-scripts.com',
        'https://vitals.vercel-insights.com',
      ],
    });
  });
});
