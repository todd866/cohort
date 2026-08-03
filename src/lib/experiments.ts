export type ExperimentDescriptor = {
  id: string;
  path: string;
  title: string;
  description: string;
};

export const EXPERIMENTS: ExperimentDescriptor[] = [
  {
    id: 'cockpit',
    path: '/x/cockpit',
    title: 'Medical Cockpit (Lab)',
    description: 'Educational toy terrain + reserve visualization for decision geometry.',
  },
];

export function isExperimentalPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;

  if (pathname === '/x' || pathname.startsWith('/x/')) return true;

  // Legacy experiment entrypoints (now redirect to /x/*).
  if (pathname === '/cockpit' || pathname.startsWith('/cockpit/')) return true;

  return false;
}

