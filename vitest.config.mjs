import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    // Full-suite worker startup and teardown were intermittently timing out.
    // Keep the run deterministic in constrained environments.
    pool: 'threads',
    fileParallelism: false,
    // fileParallelism:false means ONE long-lived worker executes all ~910 test
    // files, so its heap accumulates every module the suite touches — including
    // multi-megabyte generated content maps. On 2026-08-21 that worker died of
    // a V8 segfault (EXC_BAD_ACCESS in MarkCompactCollector::StartMarking)
    // three times in one evening, killing `test:run` with NO test summary, so a
    // release read it as a test failure. Raising the worker's old-space ceiling
    // is what actually cleared it; capping thread count alone did not.
    //
    // 2026-08-22: that ceiling had silently STOPPED APPLYING. The fix lived in
    // `test.poolOptions.threads.execArgv`, and Vitest 4 removed poolOptions —
    // it printed a DEPRECATED notice on every run that nobody acted on. Worse,
    // the flattened `test.execArgv` does NOT work either: Node's worker_threads
    // ignores V8 flags passed that way, and setting it there fails the worker
    // at startup ("Failed to start threads worker").
    //
    // So the ceiling is set via NODE_OPTIONS on the `test:run` script instead,
    // which does propagate into the thread. Measured with a probe reading
    // v8.getHeapStatistics().heap_size_limit inside a worker:
    //   without NODE_OPTIONS → 4288 MB   (i.e. the old config did nothing)
    //   with    NODE_OPTIONS → 6336 MB
    //
    // This only surfaced under `deploy:push`, which regenerates the content
    // map, starter sessions and image index in RELEASE mode (36 MB of
    // generated modules) before running the suite. Standalone `npm run
    // test:run` stayed green on the smaller dev-mode artifacts throughout.
    //
    // Honest caveat on what raising it does and does not buy: this is a
    // SEGFAULT under GC pressure, not a clean OOM, so it is probabilistic.
    // 6144 passed the full suite twice on the same release-mode artifacts that
    // had just killed it, and 846713bc records the same flag dying "three times
    // in one evening". More headroom lowers the odds; it does not prove a fix.
    // The ceiling sits at 12288 because this is a 32 GB machine and the margin
    // is free. If it still dies, the answer is to stop one worker holding all
    // 914 files' modules (fileParallelism / isolation), not a bigger number.
    //
    // If you change the ceiling, change it in package.json, and re-measure —
    // do not assume a config key here is being honoured.
    //
    // 2026-08-22: that ceiling had silently STOPPED APPLYING. Vitest 4 removed
    // `test.poolOptions` and flattened it to top-level options, so the nested
    // form above was ignored and the worker fell back to Node's ~4.1 GB
    // default. The suite still passed standalone, which is why nobody noticed —
    // it only died under `deploy:push`, which regenerates the content map,
    // starter sessions and image index in RELEASE mode first (36 MB of
    // generated modules) before running the tests. Same segfault, no summary.
    // Vitest printed a DEPRECATED warning about this on every single run.
    environment: 'node',
    environmentMatchGlobs: [
      // Use jsdom for React component tests
      ['src/**/*.test.tsx', 'jsdom'],
    ],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts', 'audit/**/*.test.ts', 'prisma/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules', '.next', 'prisma'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
