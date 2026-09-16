import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const HOUR_MS = 60 * 60 * 1000;

export const RESTRICTED_FIGURE_CACHE_CONTROL = 'private, max-age=3600';
export const OPEN_FIGURE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Content-addressed public figures can be cached indefinitely. Restricted
 * figures stay browser-private because their signed URLs are auth-gated. */
export function figureCacheControlForKey(key: string): string {
  return key.startsWith('open/')
    ? OPEN_FIGURE_CACHE_CONTROL
    : RESTRICTED_FIGURE_CACHE_CONTROL;
}

let _client: S3Client | null = null;
function client(): S3Client {
  if (_client) return _client;
  _client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_FIGURES_ENDPOINT!,
    credentials: {
      accessKeyId: process.env.R2_FIGURES_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_FIGURES_SECRET_ACCESS_KEY!,
    },
  });
  return _client;
}

export function hourFloor(d: Date): Date {
  return new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);
}

export interface SignOpts {
  /** Defaults to floor(now) — pinning to the hour gives byte-identical
   *  URLs across all sign calls within the same hour, so browser caches
   *  work properly. */
  signingDate?: Date;
  /** Defaults to 7200s (2h) — gives 1h+ of overlap at the boundary. */
  ttlSeconds?: number;
}

export async function signFigureUrl(key: string, opts: SignOpts = {}): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: process.env.R2_FIGURES_BUCKET!,
    Key: key,
  });
  return getSignedUrl(client(), command, {
    signingDate: opts.signingDate ?? hourFloor(new Date()),
    expiresIn: opts.ttlSeconds ?? 7200,
  });
}

export async function uploadFigure(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
): Promise<void> {
  await client().send(new PutObjectCommand({
    Bucket: process.env.R2_FIGURES_BUCKET!,
    Key: key,
    // Buffer and Uint8Array are valid StreamingBlobPayloadInputTypes at runtime;
    // the SDK type union is wide but TypeScript needs the explicit cast here.
    Body: body as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    ContentType: contentType,
    CacheControl: figureCacheControlForKey(key),
  }));
}
