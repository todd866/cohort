'use client';

// Simplified flag system: F → type note (optional) → Enter to submit
// No categories — 45% of flags were "Other" anyway.

interface FlagOverlayProps {
  isOpen: boolean;
  flagMessage: string;
  onSubmit: () => void;
  onClose: () => void;
  onFlagMessageChange: (message: string) => void;
}

export function FlagOverlay({
  isOpen,
  flagMessage,
  onSubmit,
  onClose,
  onFlagMessageChange,
}: FlagOverlayProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
      <div className="bg-[var(--md-surface)] rounded-xl p-4 mx-4 max-w-sm w-full">
        <textarea
          autoFocus
          value={flagMessage}
          onChange={(e) => onFlagMessageChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="What's wrong? (optional)"
          className="w-full p-3 rounded-lg bg-[var(--md-surface-container-high)] text-[var(--md-on-surface)] resize-none border-2 border-transparent focus:border-[var(--md-primary)] outline-none"
          rows={2}
        />
        <div className="flex gap-2 mt-3">
          <button
            onClick={onClose}
            className="flex-1 py-2 rounded-lg bg-[var(--md-surface-container-high)] hover:bg-[var(--md-surface-container-highest)] transition-colors text-sm"
          >
            Cancel
          </button>
          <button
            onClick={onSubmit}
            className="flex-1 py-2 rounded-lg bg-[var(--md-primary)] text-[var(--md-on-primary)] hover:opacity-90 transition-colors text-sm font-medium"
          >
            Flag
          </button>
        </div>
        <div className="text-xs text-[var(--md-on-surface-variant)] text-center mt-2 opacity-60">
          enter to submit · esc to cancel
        </div>
      </div>
    </div>
  );
}
