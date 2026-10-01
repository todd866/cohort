export interface ClinicalLessonVisualProps {
  visualId?: string;
  className?: string;
  alt?: string;
  caption?: string;
}

export function ClinicalLessonVisual({ className }: ClinicalLessonVisualProps) {
  return (
    <div
      className={`rounded-2xl border border-dashed p-5 text-center ${className ?? ''}`}
      role="note"
    >
      <p className="text-sm font-semibold">Visual unavailable in this distribution</p>
    </div>
  );
}
