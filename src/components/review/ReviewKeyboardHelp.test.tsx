/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewKeyboardHelp, reviewShortcutsFor } from './ReviewKeyboardHelp';

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

  it('names rewind keys while an earlier item is on screen', () => {
    const onClose = vi.fn();
    const { rerender } = render(<ReviewKeyboardHelp open onClose={onClose} context="card-reveal" canGoBack />);
    expect(screen.getByText('Previous item')).toBeVisible();
    expect(screen.queryByText('Next item')).toBeNull();
    rerender(<ReviewKeyboardHelp open onClose={onClose} context="card-reveal" canGoBack rewound />);
    expect(screen.getByText('Z / Left')).toBeVisible();
    expect(screen.getByText('Shift+Z / Right')).toBeVisible();
    expect(screen.getByText('Current item')).toBeVisible();
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

describe('Space on an unanswered question', () => {
  it('says it shows the answer: it reveals and records the question as not known, it does not skip it', () => {
    const space = reviewShortcutsFor('mcq-select').find((s) => s.keys.startsWith('Space'));
    expect(space?.label).toBe('Show the answer');
  });
  it.each(['card-reveal', 'card-grade', 'mcq-select', 'mcq-confidence', 'mcq-continue', 'video-rate', 'video-continue'] as const)('lists T for Talk and C for the AI chat in %s when those controls are on screen', (context) => {
    const view = render(<ReviewKeyboardHelp open onClose={() => {}} context={context} ai={{ talk: true, chat: true }} />);
    expect(screen.getByText('Talk on/off')).toBeVisible();
    expect(screen.getByText('AI chat')).toBeVisible();
    view.rerender(<ReviewKeyboardHelp open onClose={() => {}} context={context} />);
    expect(screen.queryByText('Talk on/off')).toBeNull();
  });
});
