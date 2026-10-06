import { beforeEach, describe, expect, it, vi } from 'vitest';
const { auth, limit, record } = vi.hoisted(() => ({ auth: vi.fn(), limit: vi.fn(), record: vi.fn() }));
vi.mock('@/lib/api-utils', () => ({ requireAuthOrExistingGuest: auth }));
vi.mock('@/lib/rate-limit', () => ({ checkUserRateLimit: limit }));
vi.mock('@/lib/cohort/feedback.server', () => ({ recordCohortFeedback: record, COHORT_FEEDBACK_RATINGS: ['good', 'bad', 'clear'], COHORT_FEEDBACK_REASONS: ['Context', 'Formatting', 'Needs Image', 'Giveaway', 'Rewrite', 'Length Bias', 'Acronym', 'Too Long', 'Other'] }));
import { POST } from './route';
function req(body: unknown, host = 'cohort.md') { return new Request(`https://${host}/api/cohort/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) as unknown as import('next/server').NextRequest; }
const valid = { deliveryId: 'delivery-opaque-000001', clientRequestId: 'req-1', kind: 'rating', rating: 'bad' };
describe('POST /api/cohort/feedback', () => {
  beforeEach(() => { vi.clearAllMocks(); auth.mockResolvedValue({ userId: 'guest-1', isGuest: true }); limit.mockResolvedValue({ ok: true }); record.mockResolvedValue({ status: 200, body: { success: true } }); });
  it('requires the Cohort host', async () => { expect((await POST(req(valid, 'md3.info'))).status).toBe(404); expect(auth).not.toHaveBeenCalled(); });
  it('rejects malformed feedback before persistence', async () => { expect((await POST(req({ ...valid, deliveryId: 'x' }))).status).toBe(400); expect(record).not.toHaveBeenCalled(); });
  it('accepts an existing guest and delegates the opaque delivery contract', async () => { const response = await POST(req(valid)); expect(response.status).toBe(200); expect(record).toHaveBeenCalledWith(expect.objectContaining({ userId: 'guest-1', deliveryId: valid.deliveryId, kind: 'rating' })); });
});
