'use client';

interface KeyboardHintItem {
  keys: string;
  label: string;
}

interface KeyboardHintBarProps {
  items: KeyboardHintItem[];
  visible?: boolean;
  floating?: boolean;
  className?: string;
}

export function KeyboardHintBar({
  items,
  visible = true,
  floating = false,
  className = '',
}: KeyboardHintBarProps) {
  if (!visible || items.length === 0) return null;

  const bar = (
    <div className="max-w-[calc(100vw-2rem)] overflow-x-auto">
      <div className="inline-flex items-center gap-3 rounded-full bg-[var(--md-inverse-surface)] px-4 py-2 text-xs whitespace-nowrap text-[var(--md-inverse-on-surface)] shadow-lg">
        {items.map((item, index) => (
          <span key={`${item.keys}-${item.label}`} className="inline-flex items-center gap-3">
            {index > 0 && <span className="opacity-40">·</span>}
            <span>
              <kbd className="font-mono font-semibold">{item.keys}</kbd> {item.label}
            </span>
          </span>
        ))}
      </div>
    </div>
  );

  if (floating) {
    return (
      <div className={`fixed bottom-0 left-0 right-0 z-50 flex justify-center pb-3 pointer-events-none ${className}`.trim()}>
        {bar}
      </div>
    );
  }

  return (
    <div className={`flex justify-center px-4 py-3 pointer-events-none ${className}`.trim()}>
      {bar}
    </div>
  );
}
