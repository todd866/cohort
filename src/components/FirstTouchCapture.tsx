'use client';

/**
 * The public build has no first-touch route (md3's api/user/first-touch is
 * private to md3.info), so it records nothing about where visitors came from.
 */
export const FIRST_TOUCH_KEY = 'md3_first_touch';

export function FirstTouchCapture(_props: { hostname?: string }) {
  return null;
}
