const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Safe boolean preflight; never returns or logs decoded key material. */
export function isValidExamTargetDecisionHmacKey(
  encodedKey: string | undefined,
): boolean {
  if (!encodedKey || encodedKey.length > 4_096 || !CANONICAL_BASE64.test(encodedKey)) {
    return false;
  }
  const key = Buffer.from(encodedKey, 'base64');
  return key.length >= 32 && key.toString('base64') === encodedKey;
}
