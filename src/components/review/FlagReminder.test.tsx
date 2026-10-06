/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlagReminder } from './FlagReminder';

/**
 * The reminder exists to TRAIN the real flag controls — F on a keyboard, the ⚐
 * Flag button in the toolbar on a phone. Its first version carried its own
 * "Flag a problem" button, which taught a third path that disappears once the
 * reminder is dismissed (reported 2026-10-01).
 */
describe('FlagReminder', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('points at F and the toolbar flag instead of offering its own action', () => {
    render(<FlagReminder enabled flagOpened={false} itemKey="item-1" />);
    const reminder = screen.getByRole('complementary', { name: 'Help improve cards' });
    expect(reminder).toHaveTextContent('Press F');
    expect(reminder).toHaveTextContent('⚐ Flag');
    expect(screen.queryByRole('button', { name: /flag a problem/i })).toBeNull();
    // Only the dismiss control is a button.
    expect(screen.getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['Dismiss flag reminder']);
  });

  it('can expose the current keyboard cue and parent-owned shortcut control', () => {
    const onOpenShortcuts = vi.fn();
    render(<FlagReminder enabled flagOpened={false} itemKey="item-1" keyboardHint="Space reveal · 1–4 rate" onOpenShortcuts={onOpenShortcuts} />);
    expect(screen.getByText(/⚐ Flag/)).toBeVisible();
    expect(screen.getByText(/Space reveal/)).toBeVisible();
    expect(screen.queryByText(/Spot a mistake/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Shortcuts (?)' }));
    expect(onOpenShortcuts).toHaveBeenCalledOnce();
  });

  it('retires for good once the learner opens a flag through the real control', () => {
    const view = render(<FlagReminder enabled flagOpened={false} itemKey="item-1" />);
    expect(screen.getByRole('complementary')).toBeVisible();
    view.rerender(<FlagReminder enabled={false} flagOpened itemKey="item-1" />);
    view.rerender(<FlagReminder enabled flagOpened={false} itemKey="item-1" />);
    expect(screen.queryByRole('complementary')).toBeNull();
    view.unmount();
    render(<FlagReminder enabled flagOpened={false} itemKey="item-1" />);
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  // A row above the question on every item breaks practice-exam-ux.md's "never
  // reserve a banner row above the question". Teach it on the first items, then
  // get out of the way (2026-10-01 phone sweep).
  it('retires for good after the first three items it has shown on', () => {
    const view = render(<FlagReminder enabled flagOpened={false} itemKey="a" />);
    view.rerender(<FlagReminder enabled flagOpened={false} itemKey="b" />);
    view.rerender(<FlagReminder enabled flagOpened={false} itemKey="c" />);
    expect(screen.getByRole('complementary')).toBeVisible();
    view.rerender(<FlagReminder enabled flagOpened={false} itemKey="d" />);
    expect(screen.queryByRole('complementary')).toBeNull();
    view.unmount();
    render(<FlagReminder enabled flagOpened={false} itemKey="e" />);
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('dismisses and stays dismissed after remount', () => {
    const first = render(<FlagReminder enabled flagOpened={false} itemKey="item-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss flag reminder' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    first.unmount();
    render(<FlagReminder enabled flagOpened={false} itemKey="item-1" />);
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('remains usable and dismisses in memory when browser storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<FlagReminder enabled flagOpened={false} itemKey="item-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss flag reminder' }));
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('does not appear while disabled and preserves dismissal across item changes', () => {
    const view = render(<FlagReminder enabled={false} flagOpened={false} itemKey="item-1" />);
    expect(screen.queryByRole('complementary')).toBeNull();
    view.rerender(<FlagReminder enabled flagOpened={false} itemKey="item-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss flag reminder' }));
    view.rerender(<FlagReminder enabled={false} flagOpened={false} itemKey="item-1" />);
    view.rerender(<FlagReminder enabled flagOpened={false} itemKey="item-1" />);
    expect(screen.queryByRole('complementary')).toBeNull();
  });
});
