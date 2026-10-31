import type { ButtonHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes } from 'react';

/**
 * One shape for every chip in md3, varied only by ROLE.
 *
 * 2026-10-07: the Options row drew "◐ Difficulty: Auto" as a 40px pill with a
 * glyph and a colon beside "Blur images **Off**" as a 26px pill with a bold
 * state word, and the bar beside them drew "Mixed" with the browser's chevron
 * and "Anatomy" with a text ▾. Every chip now shares one height (32px, the
 * Material 3 chip, in px so the review bar keeps its fixed height at 200% text),
 * radius, border, padding, text size and token colours.
 *
 * Conventions (chip-language.test.ts refuses hand-rolled chips):
 * - ChipSelect shows the current VALUE and a ChipChevron. A label prefix is
 *   added only when the value alone is ambiguous ("Auto"), and is always
 *   "Label: value" in one weight; "Mixed" and "Anatomy" name themselves.
 * - ChipToggle shows state ONE way everywhere: off is outlined, on is the
 *   primary-container tint with a leading check (the Material 3 filter chip,
 *   already the profile Review-menu idiom). No On/Off word, no bold.
 * - No identity icons on chips. A glyph is either on every chip in a group or
 *   on none, and none is the only rule every group can keep.
 */
export const CHIP_SHAPE =
  'inline-flex min-h-[32px] min-w-0 items-center gap-[4px] whitespace-nowrap rounded-full border px-[12px] py-[3px] text-xs leading-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--md-primary)] disabled:cursor-not-allowed disabled:opacity-60';

const CHIP_OFF =
  'border-[var(--md-outline-variant)] bg-[var(--md-surface)] text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)]';
const CHIP_ON =
  'border-[var(--md-primary)] bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)]';

/** Class for a chip rendered by an element the primitives cannot own (a Link). */
export function chipClass(on = false, extra = ''): string {
  return `${CHIP_SHAPE} ${on ? CHIP_ON : CHIP_OFF}${extra ? ` ${extra}` : ''}`;
}

/** Off-state chip whose on-state follows a wrapped checkbox or radio. */
export const CHIP_ON_WHEN_CHECKED = `${chipClass(false)} cursor-pointer has-checked:border-[var(--md-primary)] has-checked:bg-[var(--md-primary-container)] has-checked:text-[var(--md-on-primary-container)] has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-[var(--md-primary)]`;

export function ChipChevron({ className = '' }: { className?: string }) {
  return (
    <svg
      data-chip-chevron
      aria-hidden
      viewBox="0 0 12 12"
      className={`h-3 w-3 shrink-0 opacity-60 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 4.5 6 7.5 9 4.5" />
    </svg>
  );
}

export function ChipCheck({ className = '' }: { className?: string }) {
  return (
    <svg
      data-chip-check
      aria-hidden
      viewBox="0 0 12 12"
      className={`h-3 w-3 shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 6.25 5 8.75 9.5 3.5" />
    </svg>
  );
}

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value'> & {
  ref?: Ref<HTMLButtonElement>;
};

/** A dropdown trigger: [label: ]value ⌄. */
export function ChipSelect({
  label,
  value,
  labelClassName = '',
  className = '',
  type = 'button',
  ref,
  ...rest
}: ButtonProps & { label?: string; value: ReactNode; labelClassName?: string }) {
  return (
    <button ref={ref} type={type} className={chipClass(false, className)} {...rest}>
      <span className="min-w-0 truncate">
        {label && <span className={labelClassName}>{label}: </span>}
        <span className="text-[var(--md-on-surface)]">{value}</span>
      </span>
      <ChipChevron />
    </button>
  );
}

/** The same chip around a native <select>, so phones keep their OS menu. */
export function ChipNativeSelect({
  className = '',
  wrapperClassName = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { wrapperClassName?: string }) {
  return (
    <span className={`relative inline-flex min-w-0 items-center ${wrapperClassName}`}>
      <select
        data-own-chevron=""
        className={chipClass(false, `cursor-pointer appearance-none truncate pr-7 text-[var(--md-on-surface)] ${className}`)}
        {...rest}
      >
        {children}
      </select>
      <ChipChevron className="pointer-events-none absolute right-2.5 text-[var(--md-on-surface-variant)]" />
    </span>
  );
}

/**
 * An on/off chip. `semantics="switch"` is for a standing preference (role
 * switch); the default is a pressed filter or choice (aria-pressed).
 */
export function ChipToggle({
  on,
  semantics = 'pressed',
  className = '',
  type = 'button',
  children,
  ref,
  ...rest
}: ButtonProps & { on: boolean; semantics?: 'pressed' | 'switch' }) {
  const state = semantics === 'switch'
    ? { role: 'switch' as const, 'aria-checked': on }
    : { 'aria-pressed': on };
  return (
    <button ref={ref} type={type} {...state} className={chipClass(on, className)} {...rest}>
      {on && <ChipCheck />}
      {children}
    </button>
  );
}

/** A compact secondary action in chip form. */
export function ChipAction({ className = '', type = 'button', ref, ...rest }: ButtonProps) {
  return <button ref={ref} type={type} className={chipClass(false, className)} {...rest} />;
}
