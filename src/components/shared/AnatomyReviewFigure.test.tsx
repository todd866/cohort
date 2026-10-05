/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnatomyReviewFigure, prepareAnatomyFigure } from './AnatomyReviewFigure';

const fetchMock = vi.fn();
let objectUrl = 0;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => `blob:anatomy-${objectUrl++}`), revokeObjectURL: vi.fn() });
  Object.defineProperty(Image.prototype, 'decode', { configurable: true, value: vi.fn().mockResolvedValue(undefined) });
  fetchMock.mockResolvedValue(new Response(new Blob(['figure']), { status: 200 }));
});

describe('prepareAnatomyFigure', () => {
  it('fetches, decodes and reuses an exact reviewed state', async () => {
    const first = await prepareAnatomyFigure('lateral-rectus', 'prompt');
    const second = await prepareAnatomyFigure('lateral-rectus', 'prompt');
    expect(first).toEqual(second);
    expect(first.src).toContain('target=lateral-rectus&phase=prompt');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('removes a failed entry so a retry can fetch again', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response(new Blob(['figure']), { status: 200 }));
    await expect(prepareAnatomyFigure('abducens', 'answer')).rejects.toThrow('offline');
    await expect(prepareAnatomyFigure('abducens', 'answer')).resolves.toMatchObject({ src: expect.stringContaining('phase=answer') });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('AnatomyReviewFigure', () => {
  it('keeps the API source observable and returns focus from the modal', async () => {
    render(<AnatomyReviewFigure target="optic-nerve" revealed={false} alt="Optic nerve diagram" />);
    const image = await screen.findByAltText('Optic nerve diagram');
    await waitFor(() => expect(image).toHaveAttribute('data-source', '/api/anatomy/abducens?target=optic-nerve&phase=prompt'));
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge anatomy figure' }));
    const dialog = screen.getByRole('dialog', { name: 'Optic nerve diagram' });
    expect(dialog).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Enlarge anatomy figure' })).toHaveFocus();
  });

  it('keeps the previous decoded image while a new phase prepares', async () => {
    const { rerender } = render(<AnatomyReviewFigure target="lateral-rectus" revealed={false} alt="Nerve diagram" />);
    const image = await screen.findByAltText('Nerve diagram');
    await waitFor(() => expect(image).toHaveAttribute('data-source', expect.stringContaining('phase=prompt')));
    rerender(<AnatomyReviewFigure target="lateral-rectus" revealed alt="Nerve diagram" />);
    expect(screen.getByAltText('Nerve diagram')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByAltText('Nerve diagram')).toHaveAttribute('data-source', expect.stringContaining('phase=answer')));
  });
});
