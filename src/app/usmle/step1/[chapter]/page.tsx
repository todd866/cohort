import { notFound, redirect } from 'next/navigation';

/**
 * Legacy chapter URLs previously rendered indexed third-party excerpts.
 * Keep the bookmarks working without carrying that restricted-source reader
 * into the open USMLE product.
 */
const LEGACY_STEP1_CHAPTERS = [
  'biochemistry',
  'immunology',
  'microbiology',
  'pharmacology',
  'pathology',
  'cardiovascular',
  'respiratory',
  'renal',
  'gastrointestinal',
  'endocrine',
  'reproductive',
  'neurology',
  'psychiatry',
  'musculoskeletal',
  'hematology',
] as const;

const LEGACY_STEP1_CHAPTER_SET = new Set<string>(LEGACY_STEP1_CHAPTERS);

export default async function LegacyChapterPage({
  params,
}: {
  params: Promise<{ chapter: string }>;
}) {
  const { chapter } = await params;
  if (!LEGACY_STEP1_CHAPTER_SET.has(chapter)) notFound();
  redirect('/usmle/step1');
}

export function generateStaticParams() {
  return LEGACY_STEP1_CHAPTERS.map((chapter) => ({ chapter }));
}
