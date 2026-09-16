import Step1StudyClient from './Step1StudyClient';

export default async function Step1StudyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const requestedMode = Array.isArray(params.mode) ? params.mode[0] : params.mode;
  const mode = requestedMode === 'baseline' ? 'baseline' : 'daily';

  return <Step1StudyClient mode={mode} />;
}
