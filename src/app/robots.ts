import type { MetadataRoute } from 'next';

/**
 * robots.txt — served at /robots.txt by Next's metadata route.
 *
 * The current Step 1 product is an administrator-gated alpha. Only the public
 * project/operator notices are useful to crawl; study, account, compatibility,
 * and API surfaces stay out of search until the product is intentionally
 * opened beyond the alpha cohort.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/about', '/privacy', '/terms'],
        disallow: '/',
      },
    ],
  };
}
