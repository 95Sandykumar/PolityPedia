/**
 * One check list, printed as a table a tired human can read
 * (issue 44-h5-golive-readiness).
 *
 * Plain ASCII and plain spaces. No colour, no box-drawing characters: this
 * output gets pasted into a chat window and read on a phone on go-live day,
 * and an escape code that survives one terminal does not survive the next.
 *
 * The FIX lines are BELOW the table, not inside it. A fix is a whole sentence
 * and sometimes a command; squeezing it into a column makes both the fix and
 * the table unreadable, and the fixes are the part Boss acts on.
 */
import type { Check } from './types';
import { STATUS_ORDER, countByStatus } from './types';

const STATUS_WIDTH = 6;

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/** "2 FAIL, 1 WARN, 7 MANUAL, 9 PASS", worst first, zeroes left out. */
export function formatSummary(checks: readonly Check[]): string {
  const counts = countByStatus(checks);
  const parts = STATUS_ORDER.filter((status) => counts[status] > 0).map(
    (status) => counts[status] + ' ' + status,
  );
  return parts.length === 0 ? 'nothing was checked' : parts.join(', ');
}

export function formatCheckTable(checks: readonly Check[]): string {
  if (checks.length === 0) return 'nothing was checked';

  const nameWidth = Math.max(5, ...checks.map((check) => check.name.length));
  const lines: string[] = [];

  lines.push(pad('CHECK', nameWidth) + '  ' + pad('STATUS', STATUS_WIDTH) + '  DETAIL');
  lines.push('-'.repeat(nameWidth) + '  ' + '-'.repeat(STATUS_WIDTH) + '  ' + '-'.repeat(40));

  for (const check of checks) {
    lines.push(pad(check.name, nameWidth) + '  ' + pad(check.status, STATUS_WIDTH) + '  ' + check.detail);
  }

  lines.push('');
  lines.push(formatSummary(checks));

  const fixes = checks.filter((check) => check.status !== 'PASS' && check.fix);
  if (fixes.length > 0) {
    lines.push('');
    lines.push('WHAT TO DO');
    for (const check of fixes) {
      lines.push('  [' + check.status + '] ' + check.name + ': ' + check.fix);
    }
  }

  return lines.join('\n');
}
