import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildWebManifest } from '../../src/lib/offline/manifest';
import {
  PUBLIC_API_ROUTE_PATHS,
  PUBLIC_APP_HANDLER_ROUTE_PATHS,
  PUBLIC_APP_SHELL_PATHS,
  PUBLIC_METADATA_ROUTE_PATHS,
  PUBLIC_PAGE_ROUTE_PATHS,
  loadDistributionPolicy,
} from './distribution';

function artifactPaths(repoRoot: string): Set<string> {
  const policy = loadDistributionPolicy(repoRoot);
  const reviewed = fs.readFileSync(path.join(repoRoot, policy.pathManifest), 'utf8')
    .split('\n')
    .filter(Boolean);
  return new Set([
    ...reviewed,
    ...policy.generatedTextFiles.map((file) => file.path),
  ]);
}

function artifactText(repoRoot: string, filePath: string): string {
  const policy = loadDistributionPolicy(repoRoot);
  const generated = policy.generatedTextFiles.find((file) => file.path === filePath);
  return generated?.text ?? fs.readFileSync(path.join(repoRoot, filePath), 'utf8');
}

function outgoingStaticTargets(source: string): string[] {
  const targets: string[] = [];
  const patterns = [
    /\bhref\s*=\s*\{?\s*['"`]([^'"`?#]*)/g,
    /\bhref\s*:\s*['"`]([^'"`?#]*)/g,
    /\b(?:router\.(?:push|replace)|redirect|fetch|fetchWithDeadline)\(\s*['"`]([^'"`?#]*)/g,
    /\bwindow\.location\.href\s*=\s*['"`]([^'"`?#]*)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) targets.push(match[1]);
  }
  return targets;
}

const SOURCE_MODULE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.json'];

function resolveArtifactImport(
  paths: Set<string>,
  fromPath: string,
  rawSpecifier: string,
): string | null {
  let specifier: string;
  if (rawSpecifier.startsWith('@/')) {
    specifier = `src/${rawSpecifier.slice(2)}`;
  } else if (rawSpecifier.startsWith('.')) {
    specifier = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), rawSpecifier));
  } else {
    return null;
  }
  const candidates = [specifier];
  if (!path.posix.extname(specifier)) {
    for (const extension of SOURCE_MODULE_EXTENSIONS) candidates.push(`${specifier}${extension}`);
    for (const extension of SOURCE_MODULE_EXTENSIONS) {
      candidates.push(`${specifier}/index${extension}`);
    }
  }
  return candidates.find((candidate) => paths.has(candidate)) ?? null;
}

function reachableArtifactModules(repoRoot: string): Set<string> {
  const paths = artifactPaths(repoRoot);
  const pending = [
    ...PUBLIC_APP_SHELL_PATHS,
    ...PUBLIC_METADATA_ROUTE_PATHS,
    ...PUBLIC_PAGE_ROUTE_PATHS,
  ];
  const reachable = new Set<string>();
  while (pending.length > 0) {
    const filePath = pending.pop();
    if (
      !filePath
      || reachable.has(filePath)
      || !paths.has(filePath)
      || !/\.(?:js|jsx|ts|tsx)$/.test(filePath)
    ) continue;
    reachable.add(filePath);
    const source = artifactText(repoRoot, filePath);
    const importSpecifiers = [
      ...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g),
      ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...source.matchAll(/\bimport\s*['"]([^'"]+)['"]/g),
      ...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((match) => match[1]);
    for (const specifier of importSpecifiers) {
      const resolved = resolveArtifactImport(paths, filePath, specifier);
      if (resolved && !reachable.has(resolved)) pending.push(resolved);
    }
  }
  return reachable;
}

describe('public navigation and static assets', () => {
  const repoRoot = process.cwd();

  it('advertises only institution entry points with exported pages', () => {
    const paths = artifactPaths(repoRoot);
    const institution = artifactText(repoRoot, 'src/lib/institution.ts');
    const entryPaths = [...institution.matchAll(/\bentryPath:\s*'([^']+)'/g)]
      .map((match) => match[1]);

    expect(new Set(entryPaths)).toEqual(new Set(['/', '/usmle']));
    expect(paths.has('src/app/page.tsx')).toBe(true);
    expect(paths.has('src/app/usmle/page.tsx')).toBe(true);
    expect(artifactText(repoRoot, 'src/app/page.tsx')).toContain("redirect('/usmle')");
    expect(institution).toContain('export const SUPPORTS_PERSONAL_BRIEF = false;');
    expect(institution).toContain('export const SUPPORTS_PERSONAL_DOCUMENTS = false;');
    expect(institution).toContain('export const SUPPORTS_CLINICAL_EXAMS = false;');
    expect(institution).not.toMatch(/\/md[12]\b|USyd|KAT\d/);

    const hook = artifactText(repoRoot, 'src/hooks/useInstitution.ts');
    expect(hook.match(/isSupportedInstitution\(/g)?.length).toBeGreaterThanOrEqual(2);
    const picker = artifactText(repoRoot, 'src/components/ui/InstitutionPicker.tsx');
    expect(picker).toContain('Object.entries(INSTITUTIONS)');
    expect(picker).not.toMatch(/\/md[12]\b/);

    for (const excluded of [
      'src/app/(usyd-md1)/md1/page.tsx',
      'src/app/(usyd-md2)/md2/page.tsx',
      'src/app/exams/page.tsx',
      'src/app/profile/brief/page.tsx',
    ]) {
      expect(paths.has(excluded), `${excluded} must not be exported`).toBe(false);
    }
  });

  it('keeps compatibility routes and optional surfaces honest', () => {
    const paths = artifactPaths(repoRoot);
    const brief = artifactText(repoRoot, 'src/app/brief/page.tsx');
    expect(brief).toContain("redirect('/profile')");
    expect(brief).not.toContain('/profile/brief');

    const fill = artifactText(repoRoot, 'src/lib/offline/fill.ts');
    expect(fill).not.toMatch(/\/api\/study\/offline-pack|\bfetch(?:WithDeadline)?\s*\(/);
    expect(fill).toContain('return false;');

    const navigation = artifactText(repoRoot, 'src/components/Navigation.tsx');
    expect(navigation).toContain("href: '/usmle/step1'");
    expect(navigation).toContain("label: 'Study'");
    expect(navigation).toContain("session?.user ? '/profile' : '/auth/signin'");
    expect(navigation).not.toMatch(/\/content|\/exams|\/review|label: 'About'/);
    const content = artifactText(repoRoot, 'src/app/content/page.tsx');
    expect(content).toContain("redirect('/usmle/step1')");
    const settings = artifactText(
      repoRoot,
      'src/app/profile/settings/ProfileSettingsClient.tsx',
    );
    expect(settings).toContain('<PersonalDocumentsDestination />');
    expect(settings).not.toContain('/profile/documents');
    const documentsDestination = artifactText(
      repoRoot,
      'src/app/profile/settings/PersonalDocumentsDestination.tsx',
    );
    expect(documentsDestination).toContain('return null;');
    expect(documentsDestination).not.toContain('/profile/documents');
    const termProvider = artifactText(repoRoot, 'src/components/TermProvider.tsx');
    expect(termProvider).not.toMatch(/\bfetch\s*\(|\/api\/glossary/);
    const questionBankMcq = artifactText(
      repoRoot,
      'src/components/content/QuestionBankMCQ.tsx',
    );
    expect(questionBankMcq).not.toMatch(/\bfetch\s*\(|\/api\/question-bank/);
    const citation = artifactText(repoRoot, 'src/components/content/Citation.tsx');
    expect(citation).not.toMatch(/\bfetch\s*\(|\/api\/citations/);
    const activeModules = artifactText(repoRoot, 'src/hooks/useActiveModules.ts');
    expect(activeModules).not.toMatch(/\bfetch\s*\(|\/api\/modules/);
    const offlineShell = artifactText(
      repoRoot,
      'src/components/offline/OfflineTabShell.tsx',
    );
    expect(offlineShell).toContain('does not download answer-bearing study sessions');
    expect(offlineShell).toContain('href="/usmle/step1"');
    expect(offlineShell).not.toMatch(
      /ClinicalLesson|ExamProtocol|UnifiedReview|BriefView|\/api\//,
    );
    const offlineFigures = artifactText(repoRoot, 'src/lib/offline/figures.ts');
    expect(offlineFigures).not.toMatch(/\bfetch\s*\(|\/api\/figures|\/figures\//);
    expect(offlineFigures).toContain('return 0;');

    for (const prefix of [
      'src/app/api/auth/magic-link',
      'src/app/api/auth/verify',
      'src/app/admin',
      'src/app/api/admin',
      'src/app/api/analytics',
      'src/app/api/audit',
      'src/app/api/cards',
      'src/app/api/citations',
      'src/app/api/concepts',
      'src/app/api/content-audit',
      'src/app/api/content-lake',
      'src/app/api/content-quality',
      'src/app/api/cron',
      'src/app/api/deck',
      'src/app/api/deep-dive',
      'src/app/api/ecg',
      'src/app/api/exams',
      'src/app/api/figures',
      'src/app/api/glossary',
      'src/app/api/integrations',
      'src/app/api/knowledge',
      'src/app/api/learn',
      'src/app/api/manifold',
      'src/app/api/map',
      'src/app/api/mastery',
      'src/app/api/mobile',
      'src/app/api/modules',
      'src/app/api/question-bank',
      'src/app/api/questions',
      'src/app/api/quiz',
      'src/app/api/sandbox',
      'src/app/api/smp',
      'src/app/api/study',
      'src/app/api/sync',
      'src/app/api/terminology',
      'src/app/api/user/context',
      'src/app/api/user/documents',
      'src/app/api/videos',
      'src/app/auth/verify-email',
      'src/app/cards',
      'src/app/deep-dive',
      'src/app/__qa-wba4',
      'src/app/docs',
      'src/app/download/harvester',
      'src/app/f',
      'src/app/learn',
      'src/app/practice',
      'src/app/profile/documents',
      'src/app/questions',
      'src/app/qa-wba4',
      'src/app/qa-wba4-checklist',
      'src/app/review',
      'src/app/sandbox',
      'src/app/study',
      'src/app/x',
    ]) {
      expect(
        [...paths].filter((filePath) => filePath === prefix || filePath.startsWith(`${prefix}/`)),
        `${prefix} must be absent from the public artifact`,
      ).toEqual([]);
    }

    const selectedApiRoutes = [...paths]
      .filter((filePath) => /^src\/app\/api\/.+\/route\.(?:js|jsx|ts|tsx)$/.test(filePath))
      .sort();
    expect(selectedApiRoutes).toEqual([...PUBLIC_API_ROUTE_PATHS].sort());
    const selectedPages = [...paths]
      .filter((filePath) => /^src\/app(?:\/.*)?\/page\.(?:js|jsx|ts|tsx)$/.test(filePath))
      .sort();
    expect(selectedPages).toEqual([...PUBLIC_PAGE_ROUTE_PATHS].sort());
    const selectedAppHandlers = [...paths]
      .filter((filePath) => (
        !filePath.startsWith('src/app/api/')
        && /^src\/app\/.+\/route\.(?:js|jsx|ts|tsx)$/.test(filePath)
      ))
      .sort();
    expect(selectedAppHandlers).toEqual([...PUBLIC_APP_HANDLER_ROUTE_PATHS].sort());
    const selectedAppShellFiles = [...paths]
      .filter((filePath) => (
        /^src\/app(?:\/.*)?\/(?:default|error|global-error|layout|loading|not-found|template)\.(?:js|jsx|ts|tsx)$/
          .test(filePath)
      ))
      .sort();
    expect(selectedAppShellFiles).toEqual([...PUBLIC_APP_SHELL_PATHS].sort());
    const selectedMetadataRoutes = [...paths]
      .filter((filePath) => (
        /^src\/app(?:\/.*)?\/(?:apple-icon|icon|manifest|opengraph-image|robots|sitemap|twitter-image)\.(?:js|jsx|ts|tsx)$/
          .test(filePath)
      ))
      .sort();
    expect(selectedMetadataRoutes).toEqual([...PUBLIC_METADATA_ROUTE_PATHS].sort());

    for (const prefix of [
      'src/app/admin',
      'src/app/auth/verify-email',
      'src/app/cards',
      'src/app/deep-dive',
      'src/app/f',
      'src/app/learn',
      'src/app/practice',
      'src/app/questions',
      'src/app/review',
      'src/app/sandbox',
      'src/app/study',
      'src/app/x',
    ]) {
      expect(
        [...paths].filter((filePath) => filePath === prefix || filePath.startsWith(`${prefix}/`)),
        `${prefix} must not expose a public page`,
      ).toEqual([]);
    }
  });

  it('contains no outgoing production reference to an omitted route', () => {
    const paths = artifactPaths(repoRoot);
    const forbidden = [
      '/md1',
      '/md2',
      '/profile/brief',
      '/api/study/offline-pack',
      '/api/auth/magic-link',
      '/api/auth/verify',
      '/api/citations',
      '/api/glossary',
      '/api/question-bank',
      '/auth/mobile-verify',
      '/api/sync/content/cards',
      '/api/sync/content/glossary',
      '/api/sync/content/questions',
      '/api/terminology',
      '/api/user/documents',
      '/docs/harvest',
      '/download/harvester',
      '/profile/documents',
      '/settings',
      '/x/admin',
    ];
    const findings: string[] = [];

    for (const filePath of [...paths].sort()) {
      if (!filePath.startsWith('src/')) continue;
      if (!/\.(?:ts|tsx)$/.test(filePath) || /\.test\.tsx?$/.test(filePath)) continue;
      const source = artifactText(repoRoot, filePath);
      for (const target of outgoingStaticTargets(source)) {
        const omitted = forbidden.find((route) => (
          target === route || target.startsWith(`${route}/`) || target.startsWith(`${route}?`)
        ));
        if (omitted) findings.push(`${filePath} -> ${target}`);
      }
    }

    expect(findings, `outgoing links target omitted routes:\n${findings.join('\n')}`).toEqual([]);
  });

  it('keeps the reachable page graph on the reviewed Step 1 surface', () => {
    const reachable = reachableArtifactModules(repoRoot);
    const forbiddenModulePrefixes = [
      'src/components/brief/',
      'src/components/exams/',
      'src/components/review/',
    ];
    expect(
      [...reachable].filter((filePath) => (
        filePath !== 'src/components/review/LoadingSkeleton.tsx'
        && forbiddenModulePrefixes.some((prefix) => filePath.startsWith(prefix))
      )),
      'public pages must not import the omitted Brief, Clinical, or legacy review UI',
    ).toEqual([]);

    const allowedTargets = new Set([
      '/',
      '/about',
      '/auth/signin',
      '/brief',
      '/content',
      '/offline',
      '/privacy',
      '/profile',
      '/profile/settings',
      '/profile/stats',
      '/profile/support',
      '/terms',
      '/usmle',
      '/usmle/step1',
      '/usmle/step1/study',
      '/api/auth/claim-guest-progress',
      '/api/auth/session',
      '/api/content/flag',
      '/api/help',
      '/api/track',
      '/api/user',
      '/api/user/cc-subrotation',
      '/api/user/email-aliases',
      '/api/usmle/step1/answer',
      '/api/usmle/step1/progress',
      '/api/usmle/step1/session',
    ]);
    const findings: string[] = [];
    for (const filePath of [...reachable].sort()) {
      for (const target of outgoingStaticTargets(artifactText(repoRoot, filePath))) {
        if (target.startsWith('/') && !allowedTargets.has(target)) {
          findings.push(`${filePath} -> ${target}`);
        }
      }
    }
    expect(findings, `reachable page graph targets unreviewed routes:\n${findings.join('\n')}`)
      .toEqual([]);
  });

  it('ships truthful operator, alpha-access, and deployment contracts', () => {
    const paths = artifactPaths(repoRoot);
    for (const route of [
      'src/app/about/page.tsx',
      'src/app/privacy/page.tsx',
      'src/app/terms/page.tsx',
    ]) {
      expect(paths.has(route), `${route} must exist in the public artifact`).toBe(true);
    }

    const appShell = artifactText(repoRoot, 'src/components/AppShell.tsx');
    expect(appShell).toContain('href="/privacy"');
    expect(appShell).toContain('href="/terms"');
    const about = artifactText(repoRoot, 'src/app/about/page.tsx');
    expect(about).toContain('25 original');
    expect(about).toContain('not a comprehensive Step 1 bank');
    expect(about).toContain('https://www.usmle.org/about-usmle');
    expect(about).toContain('https://www.usmle.org/what-to-know/exam-security-fairness');
    expect(about).not.toMatch(
      /Never schedules reviews after your exam|Increases frequency in the final week|Ensures complete curriculum coverage|Every interaction feeds your knowledge state/,
    );
    const privacy = artifactText(repoRoot, 'src/app/privacy/page.tsx');
    expect(privacy).toContain(
      'artifact itself provides no self-service account-data export or account deletion',
    );
    expect(privacy).toContain('Before onboarding learners');
    const terms = artifactText(repoRoot, 'src/app/terms/page.tsx');
    expect(terms).toContain('LICENSE-CONTENT.md');
    expect(terms).toContain('must not contradict');

    const usmleLayout = artifactText(repoRoot, 'src/app/usmle/layout.tsx');
    expect(usmleLayout).not.toContain('adminGate');
    expect(usmleLayout).toContain('USMLE® is a registered trademark');
    expect(usmleLayout).toContain('USMLE_PUBLIC_SOURCE_URL');
    expect(artifactText(repoRoot, 'src/lib/usmle/public-source.ts')).toContain(
      'https://github.com/todd866/md3-foss',
    );
    const readme = artifactText(repoRoot, 'README.md');
    expect(readme).toContain(
      '/usmle is a public early product: guests and signed-in users can study',
    );
    expect(readme).not.toContain(
      'Current /usmle routes are administrator-gated: set ADMIN_EMAILS',
    );
    expect(readme).toContain('AUTH_TRUST_MD3_COHORT_HOSTS=true');
    expect(readme).toContain('leave AUTH_URL and NEXTAUTH_URL unset');

    const sourceRepository = artifactText(repoRoot, 'src/lib/source-repository.ts');
    expect(sourceRepository).toContain("url.protocol !== 'https:'");
    expect(sourceRepository).toContain('url.username || url.password');
    const robots = artifactText(repoRoot, 'src/app/robots.ts');
    expect(robots).toContain("allow: ['/about', '/privacy', '/terms']");
    expect(robots).toContain("disallow: '/'");
    expect(robots).not.toMatch(/\/x\/|\/sandbox|\/admin/);
  });

  it('contains no private storage deployment or harvester defaults', () => {
    const policy = loadDistributionPolicy(repoRoot);
    const paths = artifactPaths(repoRoot);
    const nextConfig = artifactText(repoRoot, 'next.config.ts');
    const analyticsConfig = artifactText(repoRoot, 'src/lib/analytics-config.ts');
    const vercel = JSON.parse(artifactText(repoRoot, 'vercel.json')) as Record<string, unknown>;
    const envExample = artifactText(repoRoot, '.env.example');
    expect(vercel).toEqual({
      framework: 'nextjs',
      buildCommand: 'npm run build:release',
    });
    expect(nextConfig).not.toMatch(
      /07a71a4e03927825c004e38b1c2ed9d1|pub-65e46a1a34f14c58abccbea86fffdac9|pub-c376f836c4cc4ecfae4c8b545e006a47|md3-anatomy|md3-videos-private|md3-user-documents-private|md3-figures|\/figures\/ecg-db/,
    );
    expect(nextConfig).toContain('vercelAnalyticsCspSources');
    expect(nextConfig).not.toMatch(
      /https:\/\/(?:va\.vercel-scripts\.com|vitals\.vercel-insights\.com)/,
    );
    expect(analyticsConfig).toContain('enabled: boolean = isVercelAnalyticsEnabled()');
    expect(analyticsConfig).toContain(': { script: [], connect: [] }');
    expect(envExample).not.toMatch(
      /07a71a4e03927825c004e38b1c2ed9d1|pub-65e46a1a34f14c58abccbea86fffdac9|pub-c376f836c4cc4ecfae4c8b545e006a47|md3-anatomy|md3-videos-private|md3-user-documents-private|md3-figures/,
    );
    for (const name of [
      'ANTHROPIC_API_KEY',
      'BLOB_READ_WRITE_TOKEN',
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_R2_ACCESS_KEY_ID',
      'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
      'CRON_SECRET',
      'GEMINI_API_KEY',
      'GITHUB_SECRET',
      'GOOGLE_CLIENT_SECRET',
      'MD3_PAPERSCOPE_TOKEN',
      'NEXTAUTH_SECRET',
      'OPENAI_API_KEY',
      'OPS_ALERT_WEBHOOK_TOKEN',
      'QDRANT_API_KEY',
      'RESEND_API_KEY',
      'R2_FIGURES_ACCESS_KEY_ID',
      'R2_FIGURES_SECRET_ACCESS_KEY',
    ]) {
      expect(envExample).toMatch(new RegExp(`^${name}=""$`, 'm'));
    }
    expect(envExample).toMatch(/^EMAIL_FROM=""$/m);

    const forbiddenText = [
      'claude.ai/referral',
      'github.com/todd866/harvest',
    ];
    const findings: string[] = [];
    for (const filePath of [...paths].sort()) {
      if (/\.test\.tsx?$/.test(filePath)) continue;
      if (!/\.(?:css|example|js|json|md|mjs|prisma|sh|sql|ts|tsx|yml)$/.test(filePath)) {
        continue;
      }
      const source = artifactText(repoRoot, filePath).toLowerCase();
      for (const needle of forbiddenText) {
        if (source.includes(needle)) findings.push(`${filePath}: ${needle}`);
      }
    }
    expect(findings, `private harvester references:\n${findings.join('\n')}`).toEqual([]);

    expect(policy.generatedTextFiles.filter((file) => file.path === 'next.config.ts'))
      .toHaveLength(1);
    expect(nextConfig).not.toContain('/static-queues');
    expect(nextConfig).not.toMatch(/source:\s*['"]\/figures|destination:\s*`?\$\{base\}\/figures/);
    expect([...paths].filter((filePath) => filePath.startsWith('public/static-queues/')))
      .toEqual([]);
    expect(policy.includeFiles).not.toContain('scripts/content/generate-static-queues.ts');
    const publicPackage = JSON.parse(artifactText(repoRoot, 'package.json')) as {
      scripts: Record<string, string>;
    };
    expect(publicPackage.scripts).not.toHaveProperty('generate:static-queues');
    expect(JSON.stringify(publicPackage.scripts)).not.toContain('generate-static-queues');
  });

  it('ships every branded icon referenced by the manifest and root metadata', () => {
    const policy = loadDistributionPolicy(repoRoot);
    const paths = artifactPaths(repoRoot);
    const manifests = [buildWebManifest('md3.info'), buildWebManifest('cohort.md')];
    expect(manifests.map((manifest) => manifest.start_url)).toEqual([
      '/',
      '/usmle/step1',
    ]);
    expect(paths.has('src/app/usmle/step1/page.tsx')).toBe(true);
    const referenced = new Set(manifests.flatMap((manifest) => (
      manifest.icons.map((icon) => icon.src.slice(1))
    )));
    const layout = artifactText(repoRoot, 'src/app/layout.tsx');
    for (const match of layout.matchAll(/["']\/(icons\/[^"']+apple-touch\.png)["']/g)) {
      referenced.add(match[1]);
    }

    expect(referenced).toEqual(new Set([
      'public/icons/cohort-192.png'.replace(/^public\//, ''),
      'public/icons/cohort-512.png'.replace(/^public\//, ''),
      'public/icons/cohort-apple-touch.png'.replace(/^public\//, ''),
      'public/icons/cohort-maskable-512.png'.replace(/^public\//, ''),
      'public/icons/md3-192.png'.replace(/^public\//, ''),
      'public/icons/md3-512.png'.replace(/^public\//, ''),
      'public/icons/md3-apple-touch.png'.replace(/^public\//, ''),
      'public/icons/md3-maskable-512.png'.replace(/^public\//, ''),
    ]));

    for (const relativeUrl of referenced) {
      const filePath = `public/${relativeUrl}`;
      expect(paths.has(filePath), `${filePath} is referenced but not exported`).toBe(true);
      const binary = policy.allowedBinaryFiles.find((entry) => entry.path === filePath);
      expect(binary).toEqual(expect.objectContaining({ licence: 'MIT', notice: 'LICENSE' }));
      expect(crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(repoRoot, filePath)))
        .digest('hex')).toBe(binary?.sha256);
    }
  });
});
