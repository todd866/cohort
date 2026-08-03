import * as fs from 'fs';

export interface IssueHistoryEntry {
  date: string; // e.g. "2026-03-08"
  flagCount: number;
  pattern: string; // e.g. "truncated-options"
  rootCause: string; // e.g. "extraction-artifact"
  fix: string; // e.g. "Agent-completed option text"
  commitRef?: string; // e.g. "b348db7"
}

const ISSUE_HISTORY_HEADER = `## Issue History

| Date | Flags | Pattern | Root Cause | Fix Applied |
|------|-------|---------|------------|-------------|`;

function formatIssueRow(entry: IssueHistoryEntry): string {
  const fixText = entry.commitRef
    ? `${entry.fix} (${entry.commitRef})`
    : entry.fix;
  return `| ${entry.date} | ${entry.flagCount} | ${entry.pattern} | ${entry.rootCause} | ${fixText} |`;
}

function formatRevisionRow(entry: IssueHistoryEntry): string {
  return `| ${entry.date} | flag-triage | Resolved ${entry.flagCount} ${entry.pattern} flags |`;
}

export function appendIssueHistory(
  talkPagePath: string,
  entry: IssueHistoryEntry
): void {
  const content = fs.readFileSync(talkPagePath, 'utf-8');
  const issueRow = formatIssueRow(entry);
  const revisionRow = formatRevisionRow(entry);

  let updated: string;

  const hasIssueHistory = content.includes('## Issue History');

  if (hasIssueHistory) {
    // Find the end of the existing Issue History table (last row before the next section or EOF)
    // We insert the new row after the last table row in the Issue History section.
    const issueHeaderIdx = content.indexOf('## Issue History');
    // Find the next ## heading after Issue History
    const afterIssueHeader = content.indexOf('\n', issueHeaderIdx);
    const nextSectionMatch = content.indexOf('\n## ', afterIssueHeader);

    if (nextSectionMatch !== -1) {
      // Insert before the blank line preceding the next section
      // Walk backwards from nextSectionMatch to find the insertion point
      // The table rows end, then there's whitespace, then the next ## heading
      // We want to insert the row at the end of the table, before any trailing whitespace
      const beforeNextSection = content.slice(0, nextSectionMatch);
      const afterNextSection = content.slice(nextSectionMatch);

      // Find the last pipe character line (last table row) in the issue history section
      const lastPipeIdx = beforeNextSection.lastIndexOf('\n|');
      if (lastPipeIdx !== -1) {
        // Find end of that line
        const endOfLastRow = beforeNextSection.indexOf('\n', lastPipeIdx + 1);
        const insertionPoint =
          endOfLastRow !== -1 ? endOfLastRow : beforeNextSection.length;
        updated =
          content.slice(0, insertionPoint) +
          '\n' +
          issueRow +
          content.slice(insertionPoint);
      } else {
        // Shouldn't happen if Issue History exists, but fallback
        updated =
          beforeNextSection + '\n' + issueRow + '\n' + afterNextSection;
      }
    } else {
      // Issue History is the last section — append to end
      const lastPipeIdx = content.lastIndexOf('\n|');
      if (lastPipeIdx !== -1) {
        const endOfLastRow = content.indexOf('\n', lastPipeIdx + 1);
        const insertionPoint =
          endOfLastRow !== -1 ? endOfLastRow : content.length;
        updated =
          content.slice(0, insertionPoint) +
          '\n' +
          issueRow +
          content.slice(insertionPoint);
      } else {
        updated = content + '\n' + issueRow + '\n';
      }
    }
  } else {
    // No Issue History section — insert before ## Revision History
    const revisionIdx = content.indexOf('## Revision History');
    if (revisionIdx === -1) {
      // No Revision History either — append at end
      updated = content + '\n' + ISSUE_HISTORY_HEADER + '\n' + issueRow + '\n';
    } else {
      updated =
        content.slice(0, revisionIdx) +
        ISSUE_HISTORY_HEADER +
        '\n' +
        issueRow +
        '\n\n' +
        content.slice(revisionIdx);
    }
  }

  // Now append the revision history row
  // Find the last line of the Revision History table
  const revHistoryIdx = updated.indexOf('## Revision History');
  if (revHistoryIdx !== -1) {
    // Find the section boundary after Revision History
    const afterRevHeader = updated.indexOf('\n', revHistoryIdx);
    const nextSectionAfterRev = updated.indexOf('\n## ', afterRevHeader);

    const searchRegion =
      nextSectionAfterRev !== -1
        ? updated.slice(0, nextSectionAfterRev)
        : updated;

    // Find the last pipe line in revision history
    const lastRevPipeIdx = searchRegion.lastIndexOf('\n|');
    if (lastRevPipeIdx !== -1) {
      const endOfLastRevRow = updated.indexOf('\n', lastRevPipeIdx + 1);
      const revInsertionPoint =
        endOfLastRevRow !== -1 ? endOfLastRevRow : updated.length;
      updated =
        updated.slice(0, revInsertionPoint) +
        '\n' +
        revisionRow +
        updated.slice(revInsertionPoint);
    }
  }

  fs.writeFileSync(talkPagePath, updated, 'utf-8');
}
