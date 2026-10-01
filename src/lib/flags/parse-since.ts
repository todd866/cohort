/**
 * Parse a --since duration string into a Date.
 *
 * Supported formats:
 *   "3d"  → 3 days ago
 *   "1w"  → 7 days ago
 *   "24h" → 24 hours ago
 *   "2026-03-06" → ISO date parsed directly
 */
export function parseSince(input: string, now: Date = new Date()): Date {
  const durationMatch = input.match(/^(\d+)([hdw])$/);

  if (durationMatch) {
    const value = parseInt(durationMatch[1], 10);
    const unit = durationMatch[2];
    const result = new Date(now);

    switch (unit) {
      case 'h':
        result.setUTCHours(result.getUTCHours() - value);
        break;
      case 'd':
        result.setUTCDate(result.getUTCDate() - value);
        break;
      case 'w':
        result.setUTCDate(result.getUTCDate() - value * 7);
        break;
    }

    return result;
  }

  // Try parsing as ISO date string
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }

  throw new Error(`Invalid --since value: "${input}". Use e.g. 3d, 1w, 24h, or 2026-03-06.`);
}
