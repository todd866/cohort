/**
 * Browser bundles resolve a bare `zod` import here (next.config.ts). Zod 4
 * probes `new Function("")` on its first object parse to decide whether to
 * compile fast parsers; md3's CSP has no 'unsafe-eval', so that probe filed a
 * CSP violation report from every page after the 28 Oct 2026 zod 4 upgrade.
 * Jitless parsing is the interpreted path zod 3 always used.
 */
import * as zod from 'zod/v4';

zod.config({ jitless: true });

export * from 'zod/v4';
export default zod;
