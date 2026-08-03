/**
 * WikiLink - Stub. The /wiki route was removed when the cohort stopped using
 * the standalone wiki — the 198 in-content references stay readable as plain
 * text. Replace with <Term> or strip per file when those MDX files are
 * touched.
 */
export function WikiLink({ children, slug }: { slug: string; children?: React.ReactNode; showPreview?: boolean }) {
  return <span>{children || slug}</span>;
}
