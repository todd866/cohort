import type { GamepadFace } from './review-gamepad';

const DOT = 2.4;
const CENTER = 7;
const OFFSET = 4.2;

const POSITIONS: Record<GamepadFace, { cx: number; cy: number }> = {
  top: { cx: CENTER, cy: CENTER - OFFSET },
  left: { cx: CENTER - OFFSET, cy: CENTER },
  right: { cx: CENTER + OFFSET, cy: CENTER },
  bottom: { cx: CENTER, cy: CENTER + OFFSET },
};

export type PadGlyphMark = GamepadFace | 'l1' | 'r1' | 'select' | 'start';

function shoulder(label: 'L1' | 'R1' | '▭' | '▷') {
  return (
    <text
      x={CENTER}
      y={CENTER + 1}
      textAnchor="middle"
      dominantBaseline="middle"
      fontSize="5.5"
      fontWeight="600"
      fill="currentColor"
    >
      {label}
    </text>
  );
}

/** Four-dot diamond; one filled face encodes the bound control. Hidden unless :root[data-input="pad"]. */
export function PadGlyph({ mark }: { mark: PadGlyphMark }) {
  const faces = (['top', 'left', 'right', 'bottom'] as const).map((pos) => (
    <circle
      key={pos}
      cx={POSITIONS[pos].cx}
      cy={POSITIONS[pos].cy}
      r={DOT}
      fill={mark === pos ? 'currentColor' : 'var(--md-outline-variant)'}
      opacity={mark === pos ? 1 : 0.55}
    />
  ));
  return (
    <svg
      aria-hidden
      width={14}
      height={14}
      viewBox="0 0 14 14"
      className="pad-glyph shrink-0"
      style={{ color: 'var(--md-on-surface-variant)' }}
    >
      {mark === 'l1' || mark === 'r1' || mark === 'select' || mark === 'start' ? (
        <>
          {faces}
          {mark === 'l1' && shoulder('L1')}
          {mark === 'r1' && shoulder('R1')}
          {mark === 'select' && shoulder('▭')}
          {mark === 'start' && shoulder('▷')}
        </>
      ) : (
        faces
      )}
    </svg>
  );
}

export function PadGlyphRow({ marks }: { marks: readonly PadGlyphMark[] }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {marks.map((mark) => (
        <PadGlyph key={mark} mark={mark} />
      ))}
    </span>
  );
}