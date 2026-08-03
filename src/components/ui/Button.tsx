'use client';

import { type ButtonHTMLAttributes } from 'react';

type ButtonVariant = 'filled' | 'outlined' | 'text' | 'tonal';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: React.ReactNode;
  loading?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
}

// React 19: ref is a plain prop for function components — no forwardRef needed.
// Source: https://react.dev/reference/react/forwardRef
export function Button({
  variant = 'filled',
  size = 'md',
  icon,
  loading,
  className = '',
  children,
  disabled,
  ref,
  ...props
}: ButtonProps) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={`btn btn-${variant} btn-${size} ${className}`.trim()}
      {...props}
    >
      {loading ? (
        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : icon ? (
        <span>{icon}</span>
      ) : null}
      {children}
    </button>
  );
}
