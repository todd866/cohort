import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, loadCorpus, loadQuestions } = vi.hoisted(() => ({
  db: {
    serveDecision: { findFirst: vi.fn() },
    question: { findUnique: vi.fn() },
    feedEvent: { findFirst: vi.fn(), create: vi.fn() },
    contentIssue: { findFirst: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  },
  loadCorpus: vi.fn(),
  loadQuestions: vi.fn(),
}));
vi.mock('@/lib/prisma', () => ({ prisma: db }));
vi.mock('@/lib/cohort/module-card-corpus.server', () => ({ loadCohortModuleCardCorpus: loadCorpus }));
vi.mock('@/lib/cohort/module-question-corpus.server', () => ({ loadCohortServableCorpus: loadQuestions }));
vi.mock('@/lib/usmle/step1-session.server', () => ({ computeStep1QuestionContentHash: vi.fn(() => 'q'.repeat(64)), isDeliverableStep1Question: vi.fn(() => true) }));

import { recordCohortFeedback } from './feedback.server';

const cardPayload = { contract: 'cohort-module-card-v1', surface: 'cohort', discipline: 'anatomy', contentHash: 'c'.repeat(64), servingFingerprint: 'f'.repeat(64) };
const base = { id: 'delivery-opaque-000001', itemId: 'card-1', itemType: 'card', sessionId: 'session-1', rotation: 'cohort-open', payload: cardPayload };

describe('Cohort feedback delivery boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.serveDecision.findFirst.mockResolvedValue(base);
    loadQuestions.mockResolvedValue({ questions: [], decisions: [] });
    loadCorpus.mockResolvedValue({ cards: [{ id: 'card-1', front: 'Canonical front', contentHash: 'c'.repeat(64), releaseFingerprint: 'f'.repeat(64) }] });
    db.feedEvent.findFirst.mockResolvedValue(null);
    db.contentIssue.findFirst.mockResolvedValue(null);
    db.feedEvent.create.mockResolvedValue({});
    db.contentIssue.create.mockResolvedValue({ id: 'issue-1', reportCount: 1 });
  });

  it('accepts an owned reviewed card delivery and records a rating without exposing its canonical id', async () => {
    const result = await recordCohortFeedback({ userId: 'guest-1', deliveryId: base.id, clientRequestId: 'req-1', kind: 'rating', rating: 'bad' });
    expect(result).toEqual({ status: 200, body: { success: true, rating: 'bad', deduped: false } });
    expect(db.feedEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ itemId: 'card-1', metadata: expect.objectContaining({ surface: 'cohort', canonicalItemId: 'card-1', serveDecisionId: base.id }) }) }));
  });


  it('accepts an owned Cohort module question delivery after release validation', async () => {
    const question = { id: 'bank:cohort:anatomy:q-123456789abc:v1', stem: 'Which nerve abducts the eye?', releaseFingerprint: 'r'.repeat(64) };
    db.serveDecision.findFirst.mockResolvedValue({ ...base, itemType: 'question', itemId: question.id, rotation: 'cohort-open', payload: { contract: 'usmle-step1-delivery-v3', surface: 'cohort', contentHash: 'q'.repeat(64), servingFingerprint: question.releaseFingerprint } });
    loadQuestions.mockResolvedValue({ questions: [question], decisions: [{ questionId: question.id, decision: { eligible: true } }] });
    const result = await recordCohortFeedback({ userId: 'guest-1', deliveryId: base.id, clientRequestId: 'req-module', kind: 'rating', rating: 'good' });
    expect(result).toMatchObject({ status: 200, body: { success: true, rating: 'good' } });
  });

  it('rejects a missing or foreign delivery before corpus reads or writes', async () => {
    db.serveDecision.findFirst.mockResolvedValue(null);
    const result = await recordCohortFeedback({ userId: 'guest-2', deliveryId: base.id, clientRequestId: 'req-2', kind: 'flag', reason: 'Formatting' });
    expect(result.status).toBe(404);
    expect(loadCorpus).not.toHaveBeenCalled();
    expect(db.contentIssue.create).not.toHaveBeenCalled();
  });

  it('fails closed when the reviewed release no longer matches', async () => {
    loadQuestions.mockResolvedValue({ questions: [], decisions: [] });
    loadCorpus.mockResolvedValue({ cards: [{ id: 'card-1', front: 'changed', contentHash: 'x'.repeat(64), releaseFingerprint: 'f'.repeat(64) }] });
    const result = await recordCohortFeedback({ userId: 'guest-1', deliveryId: base.id, clientRequestId: 'req-3', kind: 'flag', reason: 'Rewrite' });
    expect(result.status).toBe(404);
    expect(db.contentIssue.create).not.toHaveBeenCalled();
  });

  it('records a flag and safely replays the same request', async () => {
    const first = await recordCohortFeedback({ userId: 'guest-1', deliveryId: base.id, clientRequestId: 'req-4', kind: 'flag', reason: 'Needs Image', message: 'Please add a diagram' });
    expect(first.body).toMatchObject({ issueId: 'issue-1', deduped: false });
    db.contentIssue.findFirst.mockResolvedValue({ id: 'issue-1', reportCount: 1, targetId: 'card-1', targetType: 'card', metadata: { userId: 'guest-1', deliveryId: base.id, reason: 'Needs Image', messageFingerprint: '2c6597808c88096435a1b084bcb3c09c04126ba243580305c3d327126114365b' } });
    const replay = await recordCohortFeedback({ userId: 'guest-1', deliveryId: base.id, clientRequestId: 'req-4', kind: 'flag', reason: 'Needs Image', message: 'Please add a diagram' });
    expect(replay.body).toMatchObject({ issueId: 'issue-1', deduped: true });
    expect(db.contentIssue.create).toHaveBeenCalledTimes(1);
  });
  it('keeps raw feedback only in quarantine and conflicts on different prose', async () => {
    await recordCohortFeedback({userId:'guest-1',deliveryId:base.id,clientRequestId:'privacy-1',kind:'flag',reason:'Other',message:'Untrusted private report'});
    const stored = db.contentIssue.create.mock.calls[0][0].data;
    expect(stored.quarantinedMessage).toBe('Untrusted private report');
    expect(JSON.stringify(stored.metadata)).not.toContain('Untrusted private report');
    db.contentIssue.findFirst.mockResolvedValue({id:'issue-1',reportCount:1,metadata:stored.metadata});
    const replay = await recordCohortFeedback({userId:'guest-1',deliveryId:base.id,clientRequestId:'privacy-1',kind:'flag',reason:'Other',message:'A different report'});
    expect(replay.status).toBe(409);
  });

  it('retries a serialization conflict without changing the rating', async () => {
    db.$transaction.mockRejectedValueOnce(Object.assign(new Error('concurrent write'), {code:'P2034'}));
    const result = await recordCohortFeedback({userId:'guest-1',deliveryId:base.id,clientRequestId:'race-1',kind:'rating',rating:'bad'});
    expect(result.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(db.feedEvent.create).toHaveBeenCalledTimes(1);
  });

});
