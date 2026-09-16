'use client';

import { type HTMLAttributes } from 'react';

type CardVariant = 'elevated' | 'filled' | 'outlined';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  clickable?: boolean;
  ref?: React.Ref<HTMLDivElement>;
}

type DivProps = HTMLAttributes<HTMLDivElement> & { ref?: React.Ref<HTMLDivElement> };

// React 19: ref is a plain prop for function components — no forwardRef needed.
// Source: https://react.dev/reference/react/forwardRef
export function Card({ variant = 'elevated', clickable = false, className = '', children, ref, ...props }: CardProps) {
  return (
    <div
      ref={ref}
      className={`card card-${variant}${clickable ? ' card-clickable' : ''} ${className}`.trim()}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className = '', children, ref, ...props }: DivProps) {
  return (
    <div ref={ref} className={`p-4 pb-2 ${className}`.trim()} {...props}>{children}</div>
  );
}

export function CardContent({ className = '', children, ref, ...props }: DivProps) {
  return (
    <div ref={ref} className={`p-4 pt-0 ${className}`.trim()} {...props}>{children}</div>
  );
}

export function CardActions({ className = '', children, ref, ...props }: DivProps) {
  return (
    <div ref={ref} className={`p-4 pt-2 flex gap-2 justify-end ${className}`.trim()} {...props}>{children}</div>
  );
}
