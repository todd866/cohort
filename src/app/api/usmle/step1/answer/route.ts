import type { NextRequest } from 'next/server';
import { answerStep1Request } from '@/lib/usmle/step1-answer-request.server';

export async function POST(request: NextRequest) {
  return answerStep1Request(request, 'usmle-step1');
}
