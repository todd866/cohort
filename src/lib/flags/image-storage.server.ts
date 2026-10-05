import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '@/lib/config';

// Private feedback storage is intentionally independent of document ingestion,
// presigned browser uploads and public-media delivery helpers.
let client: S3Client | null = null;
function getR2Client(): S3Client {
  return client ??= new S3Client({
    region: 'auto', endpoint: config.r2Endpoint(), requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: config.r2AccessKeyId(), secretAccessKey: config.r2SecretAccessKey() },
  });
}

/** Private, server-written feedback media; never publish a bucket URL. */
export async function putPrivateR2Object(key: string, body: Buffer, contentType: string) {
  await getR2Client().send(new PutObjectCommand({ Bucket: config.userDocumentsR2BucketName(), Key: key, Body: body, ContentType: contentType, CacheControl: 'private, no-store' }), { abortSignal: AbortSignal.timeout(20_000) });
}
export async function getPrivateR2Object(key: string) {
  const result = await getR2Client().send(new GetObjectCommand({ Bucket: config.userDocumentsR2BucketName(), Key: key }));
  if (!result.Body) throw new Error('Image unavailable');
  return result.Body.transformToByteArray();
}
