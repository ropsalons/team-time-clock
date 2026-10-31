// Release notes shown in the admin panel. Add your own entries here.
export interface Release { version: string; date: string; changes: string[] }

export const CHANGELOG: Release[] = [
  { version: '1.0.0', date: '2026-01-01', changes: ['First release of the template.'] },
];
