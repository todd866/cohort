export const CONTENT_ROTATIONS = [
  { id: 'open-learning' as const, name: 'Open learning', short: 'Open', weeks: 0 },
];

export type ContentRotationId = (typeof CONTENT_ROTATIONS)[number]['id'];

export const CONTENT_WEEK_DATA: Record<
  ContentRotationId,
  Array<{ title: string; desc: string }>
> = {
  'open-learning': [],
};

export const USMLE_SUBJECTS = [
  { slug: 'psychiatry', name: 'Psychiatry', desc: 'Behavioral science and psychopharmacology' },
  { slug: 'pharmacology', name: 'Pharmacology', desc: 'Drug mechanisms and toxicology' },
  { slug: 'cardiovascular', name: 'Cardiovascular', desc: 'Physiology and cardiovascular disease' },
  { slug: 'neurology', name: 'Neurology', desc: 'Neuroanatomy and neurologic disease' },
  { slug: 'renal', name: 'Renal', desc: 'Renal physiology and disease' },
  { slug: 'gastrointestinal', name: 'Gastrointestinal', desc: 'Gastrointestinal physiology and disease' },
  { slug: 'respiratory', name: 'Respiratory', desc: 'Respiratory physiology and disease' },
  { slug: 'heme-onc', name: 'Hematology and oncology', desc: 'Blood disorders and neoplasia' },
  { slug: 'immunology', name: 'Immunology', desc: 'Innate and adaptive immunity' },
  { slug: 'microbiology', name: 'Microbiology', desc: 'Bacteria, viruses, fungi, and parasites' },
  { slug: 'biochemistry', name: 'Biochemistry', desc: 'Molecular biology, metabolism, and genetics' },
  { slug: 'endocrine', name: 'Endocrine', desc: 'Endocrine physiology and disease' },
  { slug: 'pathology', name: 'Pathology', desc: 'Cell injury, inflammation, and neoplasia' },
  { slug: 'reproductive', name: 'Reproductive', desc: 'Reproductive physiology and disease' },
  { slug: 'msk', name: 'Musculoskeletal and skin', desc: 'Musculoskeletal and dermatologic disease' },
];
