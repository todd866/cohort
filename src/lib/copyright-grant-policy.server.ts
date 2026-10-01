import 'server-only';

// Personal operator approvals never ship in the public distribution.
export const APPROVED_COPYRIGHT_EMAIL_HASHES: readonly string[] = [];
export const APPROVED_COPYRIGHT_MODULE_PRESETS: Readonly<Record<string, readonly string[]>> = {};
