import type { NextConfig } from 'next';
import { vercelAnalyticsCspSources } from './src/lib/analytics-config';

function configuredHttpsUrl(value: string | undefined): URL | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

const contentBlobBaseUrl = configuredHttpsUrl(process.env.CONTENT_BLOB_BASE_URL);
const publicMediaUrl = configuredHttpsUrl(process.env.CLOUDFLARE_R2_PUBLIC_URL);
const configuredMediaUrls = [contentBlobBaseUrl, publicMediaUrl]
  .filter((url): url is URL => url !== null);
const configuredMediaOrigins = [...new Set(configuredMediaUrls.map((url) => url.origin))];
const mediaSourceList = configuredMediaOrigins.length > 0
  ? ` ${configuredMediaOrigins.join(' ')}`
  : '';
const analyticsCsp = vercelAnalyticsCspSources();
const analyticsScriptSourceList = analyticsCsp.script.length > 0
  ? ` ${analyticsCsp.script.join(' ')}`
  : '';
const analyticsConnectSourceList = analyticsCsp.connect.length > 0
  ? ` ${analyticsCsp.connect.join(' ')}`
  : '';

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR?.trim() || '.next',
  poweredByHeader: false,
  compress: true,
  serverExternalPackages: ['@prisma/client', '.prisma/client'],
  outputFileTracingExcludes: {
    '*': ['public/figures/**', 'public/icons/**', 'public/screenshots/**'],
  },
  experimental: {
    optimizePackageImports: ['next-auth', 'katex', '@anthropic-ai/sdk', 'openai', 'zod'],
    staleTimes: { dynamic: 30, static: 180 },
  },
  images: {
    remotePatterns: configuredMediaUrls.map((url) => ({
      protocol: 'https' as const,
      hostname: url.hostname,
      port: url.port,
      pathname: '/**',
    })),
    formats: ['image/avif', 'image/webp'],
  },
  async headers() {
    const scriptDevAllowance = process.env.NODE_ENV === 'development'
      ? " 'unsafe-eval'"
      : '';
    const cspReportOnly = [
      `default-src 'self'`,
      `script-src 'self' 'unsafe-inline'${scriptDevAllowance}${analyticsScriptSourceList}`,
      `style-src 'self' 'unsafe-inline'`,
      `img-src 'self' data: blob:${mediaSourceList}`,
      `media-src 'self'${mediaSourceList}`,
      `font-src 'self' data:`,
      `connect-src 'self'${analyticsConnectSourceList}${mediaSourceList}`,
      `frame-ancestors 'none'`,
      `object-src 'none'`,
      `base-uri 'self'`,
      `form-action 'self'`,
      `report-uri /api/security/csp-report`,
    ].join('; ');
    const securityHeaders = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      { key: 'Content-Security-Policy-Report-Only', value: cspReportOnly },
    ];
    return [
      { source: '/(.*)', headers: securityHeaders },
    ];
  },
};

export default nextConfig;
