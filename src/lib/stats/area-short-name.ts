/**
 * Short area name for a debrief or a chart row, so the line is never truncated.
 */
const AREA_SHORT: Array<[RegExp, string]> = [
  [/gi system|gastrointestinal/i, 'GI'],
  [/pre and post|preoperative|perioperat/i, 'Periop'],
  [/paediatric surgery/i, 'Paed surg'],
  [/community/i, 'Community'],
  [/addiction/i, 'Addiction'],
  [/circulation/i, 'Circulation'],
  [/trauma/i, 'Trauma'],
  [/toxicolog/i, 'Tox'],
];

export function areaShortName(label: string): string {
  for (const [pattern, name] of AREA_SHORT) if (pattern.test(label)) return name;
  const words = label.split(/\s+/).filter((word) => word && !/^(and|of|the|for|care|including)$/i.test(word));
  const cut = words.slice(0, 2).join(' ');
  if (cut.length <= 22) return cut || label.slice(0, 22);
  return words[0] || label.slice(0, 22);
}
