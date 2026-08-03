import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.DOTENV_CONFIG_QUIET = 'true';

for (const key of [
  'PRIVATE_SOURCE_ACCESS_EMAILS',
  'ADMIN_EMAILS',
  'VIDEO_ACCESS_EMAILS',
  'DATABASE_URL_LOCAL',
]) {
  delete process.env[key];
}

const runtime = globalThis as {
  DOMMatrix?: unknown;
  ImageData?: unknown;
  Path2D?: unknown;
};
if (typeof runtime.DOMMatrix === 'undefined') runtime.DOMMatrix = class {};
if (typeof runtime.ImageData === 'undefined') runtime.ImageData = class {};
if (typeof runtime.Path2D === 'undefined') runtime.Path2D = class {};

vi.mock('server-only', () => ({}));
vi.mock('@/lib/logger', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { logger, default: logger };
});

const generated = join(process.cwd(), 'src/data/image-library.generated.json');
if (!existsSync(generated)) {
  execFileSync('npm', ['run', 'images:index'], { stdio: 'inherit' });
}
