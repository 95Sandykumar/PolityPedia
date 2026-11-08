/**
 * The smallest command-line parser that covers the four flags these two tools
 * take (issue 44-h5-golive-readiness).
 *
 *   --expect test|live     golive-check
 *   --site <url>           golive-check
 *   --amount <rupees>      verify-test-purchase
 *   --refunded             verify-test-purchase
 *
 * HAND-WRITTEN, not a dependency. `node:util`'s `parseArgs` would do it, but
 * these are operator tools that run on go-live day and the whole parser is
 * twenty lines: a bad flag has to produce one clear sentence, never a thrown
 * `ERR_PARSE_ARGS_UNKNOWN_OPTION` with a stack trace under it.
 */
import type { ExpectMode } from './types';

export interface ParsedArgs {
  readonly flags: Record<string, string | boolean>;
  readonly positional: string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i];
    if (!word.startsWith('--')) {
      positional.push(word);
      continue;
    }

    const body = word.slice(2);
    const equals = body.indexOf('=');
    if (equals >= 0) {
      flags[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }

    const next = argv[i + 1];
    // A following word that is itself a flag means this one is a bare switch,
    // so `--refunded --amount 299` reads the way it looks.
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }

  return { flags, positional };
}

/** `--expect`, or the error sentence to print instead. */
export function readExpect(value: string | boolean | undefined): ExpectMode | { error: string } {
  if (value === undefined) return 'test';
  if (value === 'test' || value === 'live') return value;
  return {
    error:
      '--expect must be test or live, not ' +
      (typeof value === 'boolean' ? '(nothing)' : '"' + value + '"'),
  };
}

/** `--amount`, in whole rupees, or the error sentence. */
export function readAmount(
  value: string | boolean | undefined,
  fallback: number,
): number | { error: string } {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return { error: '--amount needs a number of rupees' };
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100000) {
    return { error: '--amount must be whole rupees between 0 and 100000, not "' + value + '"' };
  }
  return parsed;
}
