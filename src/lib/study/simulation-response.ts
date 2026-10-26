import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { SimulationFocus } from './simulation-focus';
import { simulationQueueReceipt } from './simulation-item-relevance';

/** Measure the final JSON items, after scaffolds and delivery guards. This is
 * response composition, not evidence that the learner studied these items. */
export async function withSimulationResponseReceipt(response: NextResponse, focus: SimulationFocus | null | undefined): Promise<NextResponse> {
  if (!focus || !response.ok) return response;
  let payload: Record<string, unknown>;
  try { payload = await response.clone().json(); } catch { return response; }
  if (!payload || !Array.isArray(payload.items)) return response;
  const identities: { contentHash?: string }[] = [];
  const visit = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') { identities.push({}); return; }
    const item = raw as Record<string, unknown>;
    identities.push(item.type === 'card' && typeof item.front === 'string' && typeof item.back === 'string'
      ? { contentHash: createHash('sha256').update(JSON.stringify([item.front,item.back])).digest('hex') }
      : {});
  };
  payload.items.forEach(visit);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return NextResponse.json({ ...payload, simulationFocusReceipt: simulationQueueReceipt(identities,focus) }, {status:response.status,statusText:response.statusText,headers});
}
