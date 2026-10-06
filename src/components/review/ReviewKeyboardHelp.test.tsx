/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewKeyboardHelp } from './ReviewKeyboardHelp';

afterEach(() => { vi.restoreAllMocks(); });

describe('ReviewKeyboardHelp', () => {
  it('shows context-accurate bindings and restores focus on Escape and close', () => {
    const onClose = vi.fn();
    const trigger = document.createElement('button');
    trigger.textContent = 'Shortcuts';
    document.body.appendChild(trigger);
    trigger.focus();
    const view = render(<ReviewKeyboardHelp open onClose={onClose} context="mcq-select" returnFocusRef={{ current: trigger }} />);

    expect(screen.getByRole('dialog', { name: 'Review shortcuts' })).toBeVisible();
    expect(screen.getByText('Choose an answer')).toBeVisible();
    expect(screen.queryByText('Rate the card')).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(<ReviewKeyboardHelp open={false} onClose={onClose} context="mcq-select" returnFocusRef={{ current: trigger }} />);
    expect(trigger).toHaveFocus();

    view.rerender(<ReviewKeyboardHelp open onClose={onClose} context="mcq-select" returnFocusRef={{ current: trigger }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    view.rerender(<ReviewKeyboardHelp open={false} onClose={onClose} context="mcq-select" returnFocusRef={{ current: trigger }} />);
    expect(trigger).toHaveFocus();
    document.body.removeChild(trigger);
  });

  it('contains focus with Tab and does not expose review shortcuts through the modal', () => {
    const onClose = vi.fn();
    render(<ReviewKeyboardHelp open onClose={onClose} context="card-grade" />);
    const dialog = screen.getByRole('dialog', { name: 'Review shortcuts' });
    const close = screen.getByRole('button', { name: 'Close' });
    close.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(dialog, { key: '1' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps required card grading and opaque MCQ continuation distinct', () => {
    const onClose = vi.fn();
    const { rerender } = render(<ReviewKeyboardHelp open onClose={onClose} context="card-grade-required" />);
    expect(screen.queryByText('Continue without rating')).toBeNull();
    rerender(<ReviewKeyboardHelp open onClose={onClose} context="mcq-continue" />);
    expect(screen.getByText('Continue')).toBeVisible();
    expect(screen.queryByText('Set confidence')).toBeNull();
  });
});
