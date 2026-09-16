'use client';

import { KeyboardHintBar } from '@/components/shared/KeyboardHintBar';

interface ReviewKeyboardHintsProps {
  currentType: 'card' | 'question' | 'group' | 'video';
  cardFullyRevealed: boolean;
  mcqAnswered: boolean;
  canGoBack: boolean;
}

export function ReviewKeyboardHints({
  currentType,
  cardFullyRevealed,
  mcqAnswered,
  canGoBack,
}: ReviewKeyboardHintsProps) {
  const items: Array<{ keys: string; label: string }> = [];

  if (canGoBack) items.push({ keys: 'Z', label: 'back' });
  items.push({ keys: 'F', label: 'flag' });
  // The thumbs shipped mouse-only and recorded zero ratings ever. Naming the
  // keys here is most of the fix.
  items.push({ keys: 'G / B', label: 'good / bad' });

  if (currentType === 'card') {
    // After reveal, Space GRADES (Good) rather than advancing silently, so the
    // hint has to say so — a key that quietly writes to the schedule while the
    // hint says "next" is worse than no hint.
    items.push({
      keys: 'Space / Enter',
      label: cardFullyRevealed ? 'good' : 'reveal',
    });
    if (cardFullyRevealed) {
      items.push({ keys: '1-4', label: 'again / hard / good / easy' });
      items.push({ keys: 'S', label: 'skip, no grade' });
    }
  }

  if (currentType === 'question') {
    items.push({
      keys: 'Space / Enter',
      label: mcqAnswered ? 'next' : 'reveal answer',
    });
    if (mcqAnswered) {
      items.push({ keys: '1-4', label: 'confidence' });
    } else {
      items.push({ keys: '1-5', label: 'answer' });
    }
  }

  if (currentType === 'group') {
    items.push({ keys: 'Space / Enter', label: 'reveal / next' });
    items.push({ keys: '1-5', label: 'answer' });
    items.push({ keys: '1-4', label: 'confidence' });
    items.push({ keys: 'S', label: 'skip group' });
  }

  if (currentType === 'video') {
    items.push({ keys: 'Space / Enter', label: 'next' });
    items.push({ keys: '1-4', label: 'confidence' });
  }

  return <KeyboardHintBar items={items} className="pt-2 pb-0" />;
}
