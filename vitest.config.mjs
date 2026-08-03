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
