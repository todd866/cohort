const R2_BASE_HOST = /^[a-z0-9]+\.r2\.cloudflarestorage\.com$/i;
const BUCKET_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Build the origin emitted by AWS SDK virtual-hosted R2 presigning. */
export function buildR2VirtualHostedOrigin(
  endpoint: string | null | undefined,
  bucket: string | null | undefined,
): string | null {
  const bucketName = bucket?.trim().toLowerCase();
  if (!endpoint || !bucketName || !BUCKET_LABEL.test(bucketName)) return null;

  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || !R2_BASE_HOST.test(url.hostname)
    ) {
      return null;
    }
    const port = url.port ? `:${url.port}` : '';
    return `https://${bucketName}.${url.hostname.toLowerCase()}${port}`;
  } catch {
    return null;
  }
}
