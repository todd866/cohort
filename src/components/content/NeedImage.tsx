import type { Modality } from '@/lib/images/types';

interface NeedImageProps {
  condition: string;
  age?: string;
  finding?: string;
  modality?: Modality;
}

export function NeedImage({ condition, age, finding, modality }: NeedImageProps) {
  if (process.env.NODE_ENV === 'production') return null;
  const detail = [age, finding, modality].filter(Boolean).join(' • ');
  return (
    <span
      role="note"
      className="inline-block my-2 px-2 py-1 rounded-md text-xs bg-yellow-100 text-yellow-900 border border-yellow-300"
    >
      📷 needed: <span className="font-medium">{condition}</span>
      {detail && <span className="ml-1 opacity-75">({detail})</span>}
    </span>
  );
}
