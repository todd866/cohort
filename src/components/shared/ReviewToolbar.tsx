import type {ReactNode} from 'react';

export function ReviewToolbar({children}: {children: ReactNode}) {
  return <div role="toolbar" aria-label="Review toolbar" className="@container/review-toolbar sticky top-0 z-10 h-[52px] px-[8px] min-[400px]:px-[12px] flex flex-nowrap items-center justify-between gap-[6px] min-[400px]:gap-[8px] border-b border-[var(--md-outline-soft)] bg-[var(--md-surface)]">{children}</div>;
}
