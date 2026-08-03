import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const DELIVERY_RESOLVER = 'filterDeliverableReinforcementCardRows';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function walk(relativeDirectory: string): string[] {
  const absoluteDirectory = path.join(ROOT, relativeDirectory);
  return fs.readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeDirectory, entry.name);
    return entry.isDirectory() ? walk(relativePath) : [relativePath];
  });
}

/**
 * These files serialize answer-bearing Card fields outside a direct App Router
 * query. Keep this list explicit: it is both the review inventory and a change
 * detector for the less searchable cache/artifact/LLM paths.
 */
const INDIRECT_CARD_EGRESS: Record<string, string> = {
  // Every unified-session lane either resolves candidates itself or finishes
  // in the shared hydration resolver.
  'src/lib/study/unified-session-hydration.ts': DELIVERY_RESOLVER,
  'src/lib/study/unified-session-instant.ts': DELIVERY_RESOLVER,
  'src/lib/study/unified-session-starter.ts': DELIVERY_RESOLVER,
  'src/lib/study/unified-session-cache.ts': DELIVERY_RESOLVER,
  'src/lib/study/unified-session-rereview.ts': DELIVERY_RESOLVER,
  'src/lib/study/unified-session-review-filter.ts': DELIVERY_RESOLVER,
  'src/lib/study/unified-session-manifold.ts': 'loadScheduledItemHydrationData',
  'src/lib/study/unified-session-cache-compute.ts': 'loadScheduledItemHydrationData',
  'src/lib/study/unified-session-service.ts': 'buildManifoldSession',
  'src/app/api/study/unified-session/route.ts': 'getUnifiedSession',
  'src/app/api/integrations/paperscope/review/session/route.ts': 'getUnifiedSession',
  'src/app/api/study/offline-pack/route.ts': 'computeAndHydrateSession',

  // Durable/server caches and background/external transports.
  'src/lib/study-queue.ts': DELIVERY_RESOLVER,
  'src/lib/content-gen/liked-variants.ts': DELIVERY_RESOLVER,
  'src/lib/manifold/exam-relevance.ts': DELIVERY_RESOLVER,
  'src/lib/manifold/sparse-regions.ts': DELIVERY_RESOLVER,
  'src/lib/manifold/inference.ts': DELIVERY_RESOLVER,
  'src/lib/content-issue-validation.ts': DELIVERY_RESOLVER,

  // Public/generated answer-bearing artifacts.
  'scripts/content/generate-content-map.ts': DELIVERY_RESOLVER,
  'scripts/content/generate-starter-sessions.ts': DELIVERY_RESOLVER,
};

// These surfaces remain part of the private application but are omitted
// from the scoped FOSS product. Every other inventory entry is mandatory in a
// public artifact; a missing path must therefore fail instead of silently
// shrinking this containment test.
const INTERNAL_ONLY_INDIRECT_EGRESS = new Set([
  'src/app/api/integrations/paperscope/review/session/route.ts',
  'src/app/api/study/offline-pack/route.ts',
  'src/app/api/study/unified-session/route.ts',
]);

describe('raw USMLE reinforcement Card egress inventory', () => {
  it('requires the lineage resolver in every direct route/page that selects Card answer content', () => {
    const directEgressSources = walk('src/app')
      .filter((relativePath) => /(?:route\.ts|page\.tsx?)$/.test(relativePath))
      .filter((relativePath) => {
        const source = read(relativePath);
        const selectsFrontOrBack = /\b(?:front|back|backs)\s*:\s*true\b/.test(source);
        const selectsContextFromCardModel = (
          /(?:prisma|tx)\.card\.(?:findMany|findFirst|findUnique)/.test(source)
          && /\bcontext\s*:\s*true\b/.test(source)
        );
        const selectsContextFromNestedCard = (
          /\bcard\s*:\s*\{[\s\S]{0,800}\bcontext\s*:\s*true\b/.test(source)
        );
        return selectsFrontOrBack || selectsContextFromCardModel || selectsContextFromNestedCard;
      })
      .sort();

    const missing = directEgressSources.filter(
      (relativePath) => !read(relativePath).includes(DELIVERY_RESOLVER),
    );

    expect(missing).toEqual([]);
    // Guard against a broken discovery expression while respecting the scoped
    // public artifact. Retiring MedKit's content-pack route deliberately
    // reduced the private checkout inventory from 15 to 14; recurrence is
    // covered by src/app/api/retired-medkit-routes.test.ts. The public Step 1
    // artifact retains only its reviewed content-flag consumer.
    if (fs.existsSync(path.join(ROOT, 'FOSS-DISTRIBUTION-MANIFEST.json'))) {
      expect(directEgressSources).toEqual(['src/app/api/content/flag/route.ts']);
    } else {
      expect(directEgressSources).toContain('src/app/api/content/flag/route.ts');
      expect(directEgressSources.length).toBeGreaterThanOrEqual(14);
    }
  });

  it('pins every indirect API, session, cache, external-model, and artifact path to its boundary', () => {
    for (const [relativePath, marker] of Object.entries(INDIRECT_CARD_EGRESS)) {
      if (!fs.existsSync(path.join(ROOT, relativePath))) {
        expect(
          INTERNAL_ONLY_INDIRECT_EGRESS.has(relativePath),
          `${relativePath} is a mandatory public containment surface`,
        ).toBe(true);
        continue;
      }
      expect(read(relativePath), `${relativePath} must retain ${marker}`).toContain(marker);
    }
  });

  it('purges pre-containment offline answer payloads and keeps new packs on schema v6+', () => {
    const source = read('src/lib/offline/pack.ts');
    expect(source).toMatch(/OFFLINE_PACK_SCHEMA_VERSION\s*=\s*6/);
    expect(source).toContain("row?.sourceComponent === 'QuestionReinforcement'");
    expect(source).toContain('localStorage.removeItem(OFFLINE_PACK_KEY)');
  });

  it('keeps the protected-card database audit in every strict release build', () => {
    const pkg = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['build:release']).toContain('npm run usmle:reinforcement:audit');
    expect(pkg.scripts['build:isolated:release']).toContain('npm run usmle:reinforcement:audit');
    expect(pkg.scripts['usmle:reinforcement:audit']).not.toContain('--apply');
    expect(pkg.scripts['usmle:reinforcement:repair:apply']).toContain('--apply');
  });
});
