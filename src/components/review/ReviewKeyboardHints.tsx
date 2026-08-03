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

  if (currentType === 'card') {
    items.push({
      keys: 'Space / Enter',
      label: cardFullyRevealed ? 'next' : 'reveal',
    });
    if (cardFullyRevealed) {
      items.push({ keys: '1-4', label: 'confidence' });
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
