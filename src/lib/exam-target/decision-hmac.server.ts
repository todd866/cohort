import 'server-only';

import { createHmac } from 'node:crypto';
import { isValidExamTargetDecisionHmacKey } from './decision-hmac-key';

const UNAVAILABLE = 'exam-target decision tokenization is unavailable';

export function loadExamTargetDecisionTokenizer(): (itemKey: string) => string {
  const encodedKey = process.env.EXAM_TARGET_DECISION_HMAC_KEY_BASE64;
  if (!isValidExamTargetDecisionHmacKey(encodedKey)) throw new Error(UNAVAILABLE);
  const key = Buffer.from(encodedKey!, 'base64');
  return (itemKey: string) => {
    if (typeof itemKey !== 'string' || itemKey.length === 0 || itemKey.length > 512) {
      throw new Error('exam-target item tokenization failed');
    }
    return createHmac('sha256', key).update(itemKey).digest('hex');
  };
}
