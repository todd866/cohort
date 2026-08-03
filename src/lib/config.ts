/**
 * Centralized environment configuration.
 *
 * Accessors are lazy (evaluated on first call) so importing this module
 * in tests doesn't blow up when env vars are missing.
 *
 * Use requireEnv() for vars that must exist at runtime.
 * Use optionalEnv() for vars with sensible defaults.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optionalEnv(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

type PrivateR2BucketEnvName =
  | 'CLOUDFLARE_R2_VIDEO_BUCKET_NAME'
  | 'CLOUDFLARE_R2_USER_DOCUMENTS_BUCKET_NAME';

function privateR2BucketName(name: PrivateR2BucketEnvName): string {
  const privateBucket = requireEnv(name).trim();
  const publicMediaBucket = requireEnv('CLOUDFLARE_R2_BUCKET_NAME').trim();
  if (!privateBucket) {
    throw new Error(`Missing required env var: ${name}`);
  }
  if (!publicMediaBucket) {
    throw new Error('Missing required env var: CLOUDFLARE_R2_BUCKET_NAME');
  }
  if (privateBucket.toLowerCase() === publicMediaBucket.toLowerCase()) {
    throw new Error(
      `${name} must be a dedicated private bucket, not the public media bucket`,
    );
  }

  const otherName: PrivateR2BucketEnvName = name === 'CLOUDFLARE_R2_VIDEO_BUCKET_NAME'
    ? 'CLOUDFLARE_R2_USER_DOCUMENTS_BUCKET_NAME'
    : 'CLOUDFLARE_R2_VIDEO_BUCKET_NAME';
  const otherPrivateBucket = process.env[otherName]?.trim();
  if (
    otherPrivateBucket
    && privateBucket.toLowerCase() === otherPrivateBucket.toLowerCase()
  ) {
    throw new Error(
      'CLOUDFLARE_R2_VIDEO_BUCKET_NAME and CLOUDFLARE_R2_USER_DOCUMENTS_BUCKET_NAME must use separate private buckets',
    );
  }

  return privateBucket;
}

export const config = {
  // Runtime flags
  isProduction: process.env.NODE_ENV === 'production',
  isDev: process.env.NODE_ENV === 'development',

  // Cloudflare R2
  r2Endpoint: () => requireEnv('CLOUDFLARE_R2_ENDPOINT'),
  r2AccessKeyId: () => requireEnv('CLOUDFLARE_R2_ACCESS_KEY_ID'),
  r2SecretAccessKey: () => requireEnv('CLOUDFLARE_R2_SECRET_ACCESS_KEY'),
  r2BucketName: () => requireEnv('CLOUDFLARE_R2_BUCKET_NAME'),
  videoR2BucketName: () => privateR2BucketName('CLOUDFLARE_R2_VIDEO_BUCKET_NAME'),
  userDocumentsR2BucketName: () => privateR2BucketName(
    'CLOUDFLARE_R2_USER_DOCUMENTS_BUCKET_NAME',
  ),

  // Qdrant
  qdrantUrl: () => optionalEnv('QDRANT_URL'),
  qdrantApiKey: () => optionalEnv('QDRANT_API_KEY'),
  qdrantCollection: () => optionalEnv('QDRANT_COLLECTION', 'md3-cards'),

  // AI
  geminiApiKey: () => optionalEnv('GEMINI_API_KEY'),
  openaiApiKey: () => optionalEnv('OPENAI_API_KEY'),

  // Content
  contentLakePath: () => optionalEnv('CONTENT_LAKE_PATH'),
  calibrationPath: () => optionalEnv('CALIBRATION_PATH'),
} as const;
