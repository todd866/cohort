export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body is too large');
    this.name = 'RequestBodyTooLargeError';
  }
}

/**
 * Read a request body without ever buffering more than maxBytes.
 *
 * Content-Length is only an early rejection hint: chunked and missing-length
 * bodies are counted while streaming and cancelled as soon as they cross the
 * cap. UTF-8 is decoded strictly so malformed input fails parsing instead of
 * being silently normalised.
 */
export async function readBoundedRequestText(
  request: Request,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes must be a positive safe integer');
  }

  const declaredLength = request.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const length = Number(declaredLength);
    if (Number.isSafeInteger(length) && length > maxBytes) {
      throw new RequestBodyTooLargeError();
    }
  }

  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}

export async function readBoundedRequestJson(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  return JSON.parse(await readBoundedRequestText(request, maxBytes));
}
