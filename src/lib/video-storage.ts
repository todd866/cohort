import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '@/lib/config';

const VIDEO_URL_TTL_SECONDS = 15 * 60;
let client: S3Client | null = null;

function getVideoClient(): S3Client {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: config.r2Endpoint(),
      credentials: {
        accessKeyId: config.r2AccessKeyId(),
        secretAccessKey: config.r2SecretAccessKey(),
      },
    });
  }
  return client;
}

/** Short-lived delivery URL from the dedicated non-public video bucket. */
export async function getSignedVideoUrl(key: string): Promise<string> {
  if (!key || key.length > 1_024 || key.includes('\0')) {
    throw new Error('Invalid video object key');
  }
  return getSignedUrl(
    getVideoClient(),
    new GetObjectCommand({ Bucket: config.videoR2BucketName(), Key: key }),
    { expiresIn: VIDEO_URL_TTL_SECONDS },
  );
}
