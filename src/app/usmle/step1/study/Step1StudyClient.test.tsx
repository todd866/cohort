/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Step1StudyClient from './Step1StudyClient';

const session = {
  sessionId: 'opaque-session',
  mode: 'baseline',
  requestedSize: 10,
  deliveredSize: 1,
  items: [{
    deliveryId: 'delivery-opaque-000001',
    stem: 'Which mechanism best explains this finding?',
    options: [
      { label: 'A', text: 'First display option' },
      { label: 'B', text: 'Second display option' },
      { label: 'C', text: 'Third display option' },
      { label: 'D', text: 'Fourth display option' },
    ],
    domain: 'usmle/step1/endocrine',
    difficulty: 'medium',
    questionType: 'mechanism',
    attribution: { text: 'MD3 contributors', licence: 'CC-BY-4.0' },
  }],
};

const answer = {
  deduped: false,
  answer: {
    deliveryId: 'delivery-opaque-000001',
    questionId: 'bank:usmle-step1:answer:v1',
    selectedDisplayLabel: 'B',
    correctDisplayLabel: 'B',
    isCorrect: true,
    attemptNumber: 1,
    explanation: 'The correct mechanism follows from the cited physiology.',
    optionExplanations: [
      { label: 'A', explanation: 'This has the opposite effect.', misconception: 'Reversed mechanism.' },
      { label: 'B', explanation: 'This is the supported mechanism.', misconception: null },
      { label: 'C', explanation: 'This affects another pathway.', misconception: 'Adjacent pathway.' },
      { label: 'D', explanation: 'This occurs in another condition.', misconception: 'Wrong condition.' },
    ],
    attribution: { text: 'MD3 contributors', licence: 'CC-BY-4.0' },
    citation: {
      kind: 'passage',
      title: 'Official public-domain source',
      publisher: 'National Institutes of Health',
      canonicalUrl: 'https://www.niddk.nih.gov/official-source',
      attribution: 'Source: NIDDK',
      licence: { id: 'us-gov', url: 'https://www.nih.gov/copyright' },
      passageLocator: 'Mechanism section',
      quote: 'A short registry-approved quotation.',
    },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Step1StudyClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(session))
      .mockResolvedValueOnce(jsonResponse(answer)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries session issuance with the same POST request identity', async () => {
    vi.mocked(fetch).mockReset().mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce(jsonResponse(session));
    render(<Step1StudyClient mode="baseline" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry session' }));
    await screen.findByText(session.items[0].stem);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe('/api/usmle/step1/session');
    expect(calls[0][1]?.method).toBe('POST');
    const first = JSON.parse(String(calls[0][1]?.body));
    expect(first).toMatchObject({ mode: 'baseline', size: 10, serveRequestId: expect.any(String) });
    expect(calls[1][1]?.body).toBe(calls[0][1]?.body);
  });

  it('offers a new request identity after a revoked session', async () => {
    vi.mocked(fetch).mockReset().mockResolvedValueOnce(jsonResponse({ code: 'delivery_revoked' }, 410)).mockResolvedValueOnce(jsonResponse(session));
    render(<Step1StudyClient mode="baseline" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start new session' }));
    await screen.findByText(session.items[0].stem);
    const calls = vi.mocked(fetch).mock.calls;
    expect(JSON.parse(String(calls[1][1]?.body)).serveRequestId).not.toBe(JSON.parse(String(calls[0][1]?.body)).serveRequestId);
  });

  it('ignores an old request error after the learner changes mode', async () => {
    let resolveOld!: (response: Response) => void;
    vi.mocked(fetch).mockReset()
      .mockReturnValueOnce(new Promise<Response>(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce(jsonResponse({ ...session, mode: 'daily' }));
    const view = render(<Step1StudyClient mode="baseline" />);
    view.rerender(<Step1StudyClient mode="daily" />);
    await screen.findByText(session.items[0].stem);
    await act(async () => resolveOld(jsonResponse({ code: 'delivery_revoked' }, 410)));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(session.items[0].stem)).toBeInTheDocument();
  });

  it('keeps answers and canonical identifiers out of the pre-grade view and request', async () => {
    render(<Step1StudyClient mode="baseline" />);

    expect(await screen.findByText(session.items[0].stem)).toBeInTheDocument();
    expect(screen.queryByText(answer.answer.explanation)).not.toBeInTheDocument();
    expect(screen.queryByText(answer.answer.citation.title)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(answer.answer.questionId);

    fireEvent.click(screen.getByRole('button', { name: /B\. Second display option/i }));
    fireEvent.click(screen.getByRole('button', { name: /Good \(3\)/i }));

    await screen.findByText('Correct');
    const answerCall = vi.mocked(fetch).mock.calls.find(([url]) => url === '/api/usmle/step1/answer');
    expect(answerCall).toBeDefined();
    const body = JSON.parse(String((answerCall?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      deliveryId: 'delivery-opaque-000001',
      selectedDisplayLabel: 'B',
      confidence: 3,
    });
    expect(Object.keys(body).sort()).toEqual([
      'confidence',
      'deliveryId',
      'responseTimeMs',
      'selectedDisplayLabel',
    ]);
    expect(body).not.toHaveProperty('questionId');
    expect(body).not.toHaveProperty('correctDisplayLabel');

    expect(screen.getByText(answer.answer.explanation)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: answer.answer.citation.title })).toHaveAttribute(
      'href',
      answer.answer.citation.canonicalUrl,
    );
    expect(screen.getByText(/short registry-approved quotation/i)).toBeInTheDocument();
    expect(screen.getByText(answer.answer.citation.attribution)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: answer.answer.citation.licence.id })).toHaveAttribute(
      'href',
      answer.answer.citation.licence.url,
    );
  });

  it('grades on the confidence press, and never before an option is chosen', async () => {
    render(<Step1StudyClient mode="baseline" />);
    await screen.findByText(session.items[0].stem);

    // Confidence is the grading action, so it cannot exist before a choice —
    // this is what stops it reading as a gate the way a disabled submit did.
    expect(screen.queryByRole('button', { name: /Good \(3\)/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /B\. Second display option/i }));
    expect(screen.getByRole('button', { name: /Good \(3\)/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check answer' })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: '3' });
    await screen.findByText('Correct');
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[1][1] as RequestInit).body));
    expect(body).toMatchObject({ selectedDisplayLabel: 'B', confidence: 3 });
  });

  it('supports an answerless skip', async () => {
    const skippedAnswer = {
      ...answer,
      answer: { ...answer.answer, selectedDisplayLabel: null, isCorrect: false },
    };
    vi.mocked(fetch)
      .mockReset()
      .mockResolvedValueOnce(jsonResponse(session))
      .mockResolvedValueOnce(jsonResponse(skippedAnswer));

    render(<Step1StudyClient mode="baseline" />);
    await screen.findByText(session.items[0].stem);

    fireEvent.click(screen.getByRole('button', { name: 'Skip this question' }));
    fireEvent.keyDown(window, { key: '2' });

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[1][1] as RequestInit).body));
    expect(body.selectedDisplayLabel).toBeNull();
    expect(body.confidence).toBe(2);
  });

  it('reveals per-option rationale behind a tap, not as a wall of text', async () => {
    render(<Step1StudyClient mode="baseline" />);
    await screen.findByText(session.items[0].stem);
    fireEvent.click(screen.getByRole('button', { name: /B\. Second display option/i }));
    fireEvent.click(screen.getByRole('button', { name: /Good \(3\)/i }));
    await screen.findByText('Correct');

    const rationale = answer.answer.optionExplanations[0].explanation;
    expect(screen.queryByText(new RegExp(rationale))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /A\. First display option/i }));
    expect(screen.getByText(new RegExp(rationale))).toBeInTheDocument();
  });

  it('shows a bounded retry without rendering a server error body', async () => {
    vi.mocked(fetch).mockReset().mockResolvedValueOnce(
      jsonResponse({ error: 'private database detail' }, 500),
    );

    render(<Step1StudyClient mode="daily" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not build/i);
    expect(document.body.textContent).not.toContain('private database detail');
    expect(screen.getByRole('button', { name: 'Retry session' })).toBeInTheDocument();
  });

  it('retries an uncertain write with the byte-equivalent answer payload', async () => {
    vi.mocked(fetch)
      .mockReset()
      .mockResolvedValueOnce(jsonResponse(session))
      .mockRejectedValueOnce(new Error('connection lost after write'))
      .mockResolvedValueOnce(jsonResponse(answer));

    render(<Step1StudyClient mode="baseline" />);
    await screen.findByText(session.items[0].stem);
    fireEvent.click(screen.getByRole('button', { name: /B\. Second display option/i }));
    fireEvent.click(screen.getByRole('button', { name: /Good \(3\)/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/retry/i);
    fireEvent.click(screen.getByRole('button', { name: 'Retry answer' }));
    await screen.findByText('Correct');

    const firstBody = (vi.mocked(fetch).mock.calls[1][1] as RequestInit).body;
    const retryBody = (vi.mocked(fetch).mock.calls[2][1] as RequestInit).body;
    expect(retryBody).toBe(firstBody);
  });

  it('does not invite an endless retry when the server revokes a delivery', async () => {
    vi.mocked(fetch)
      .mockReset()
      .mockResolvedValueOnce(jsonResponse(session))
      .mockResolvedValueOnce(jsonResponse({ code: 'delivery_content_changed' }, 409));

    render(<Step1StudyClient mode="baseline" />);
    await screen.findByText(session.items[0].stem);
    fireEvent.click(screen.getByRole('button', { name: /B\. Second display option/i }));
    fireEvent.click(screen.getByRole('button', { name: /Good \(3\)/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/fresh session/i);
    // No retry affordance, and no way to grade — the footer is withdrawn
    // entirely rather than left on screen disabled.
    expect(screen.queryByRole('button', { name: 'Retry answer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Confidence/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Return to Step 1' })).toHaveAttribute(
      'href',
      '/usmle/step1',
    );
  });
});
