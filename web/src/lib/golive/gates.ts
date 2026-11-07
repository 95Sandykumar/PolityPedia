/**
 * The seven manual gates of H5 (issue 44-h5-golive-readiness).
 *
 * These are the checks no program can do. A CA has to answer on GST, a human
 * has to read the Adda247 contract, Razorpay has to approve a KYC. So the
 * tool does the only useful thing it can: it keeps the list, it refuses to
 * call the app ready while one is open, and it records WHO cleared each gate
 * and WHEN, because "I think we did that in October" is not a record.
 *
 * WHERE THE FILE LIVES AND WHY IT IS GITIGNORED. `web/golive.json` is Boss's
 * signature sheet, with names and dates on it, and it describes the state of
 * one real business at one moment. It is not source. `web/golive.example.json`
 * is the template that IS committed, so a fresh clone knows the shape.
 *
 * WHY A GATE NEEDS A NAME AND A DATE TO COUNT AS DONE. `{"done": true}` on its
 * own is a box somebody ticked. A name and a date is something that can be
 * checked back against a CA's email. A `done: true` with neither is refused
 * and reported as a problem, so the file cannot be made to lie by accident.
 */
import type { Check, ExpectMode } from './types';

export interface Gate {
  readonly id: string;
  /** Four or five words, for the table. */
  readonly title: string;
  /** Who clears it. Boss needs to know who to chase. */
  readonly who: string;
  /** What clearing it means, in plain words. */
  readonly what: string;
}

/**
 * H5, in the order the ticket lists them.
 *
 * X1, X3, X4 and X8 are design.md's open questions; B9 is its platform
 * decision; AS6 is the one number in the ledger that is still a guess.
 */
export const GOLIVE_GATES: readonly Gate[] = [
  {
    id: 'X1',
    title: 'payout method',
    who: 'Boss',
    what: 'Monthly manual bank transfer from the teacher_ledger report is confirmed as the v1 payout. Razorpay Route (auto split, needs teacher KYC) stays in V2.',
  },
  {
    id: 'X3',
    title: 'revenue split',
    who: 'Boss, with each teacher',
    what: 'The revenue share percentage per teacher is agreed in writing, and it is worked out on the NET (gross minus GST minus the gateway fee), not on the gross.',
  },
  {
    id: 'X4',
    title: 'GST and TCS',
    who: 'A chartered accountant',
    what: 'A CA confirms the GST treatment and the e-commerce operator TCS on teacher sales. The code reads prices as GST-INCLUSIVE and backs 18% out of them (public.gst_divisor() in 0027_ledger.sql). If the CA says otherwise, that one function is the change.',
  },
  {
    id: 'X8',
    title: 'Adda247 contract',
    who: 'Boss',
    what: 'Boss has read the Adda247 employment or consulting contract and is satisfied that running PolityPedia and taking money through it breaks no clause in it.',
  },
  {
    id: 'B9',
    title: 'Vercel Pro',
    who: 'Boss',
    what: 'The Vercel plan is Pro. The free plan has no commercial-use right and its function limits will cut a paid checkout off mid-flight.',
  },
  {
    id: 'AS6',
    title: 'real Razorpay fee',
    who: 'Boss, from the Razorpay dashboard',
    what: 'The real fee percentage on a live Rs 299 sale is known and written down. The ledger stores whatever fee the webhook reports, so a wrong assumption does not corrupt a row, but every payout forecast until now used a guess.',
  },
  {
    id: 'KYC',
    title: 'Razorpay KYC',
    who: 'Razorpay',
    what: 'The Razorpay account KYC is approved and live keys have been issued. Until then there are no live keys to switch to.',
  },
];

export interface GateState {
  readonly done: boolean;
  readonly by: string | null;
  readonly date: string | null;
}

export interface GoliveFile {
  /** True when there is no `web/golive.json` at all. */
  readonly missing: boolean;
  readonly gates: Record<string, GateState>;
  /** Anything wrong with the file itself, by gate id. */
  readonly problems: readonly string[];
}

const NOT_DONE: GateState = { done: false, by: null, date: null };

function text(value: unknown, max = 120): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/**
 * Read `web/golive.json`, or decide that nothing is cleared.
 *
 * EVERY failure answers "nothing is done". Broken JSON, a missing file, a
 * `gates` key that is not an object: all of them mean the tool cannot prove a
 * gate was cleared, and the only safe reading of "cannot prove" is "not
 * cleared". A parser that guessed would be a parser that could wave a wrong
 * go-live through on a typo.
 */
export function parseGoliveFile(raw: string | null | undefined): GoliveFile {
  const gates: Record<string, GateState> = {};
  for (const gate of GOLIVE_GATES) gates[gate.id] = NOT_DONE;

  if (raw === null || raw === undefined || raw.trim() === '') {
    return { missing: true, gates, problems: [] };
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { missing: false, gates, problems: ['web/golive.json is not readable JSON'] };
  }

  const found = (body as { gates?: unknown } | null)?.gates;
  if (typeof found !== 'object' || found === null || Array.isArray(found)) {
    return { missing: false, gates, problems: ['web/golive.json has no "gates" object'] };
  }

  const problems: string[] = [];
  const table = found as Record<string, unknown>;

  for (const gate of GOLIVE_GATES) {
    const one = table[gate.id];
    if (typeof one !== 'object' || one === null) continue;

    const row = one as { done?: unknown; by?: unknown; date?: unknown };
    const by = text(row.by);
    const date = text(row.date, 40);

    if (row.done !== true) {
      gates[gate.id] = { done: false, by, date };
      continue;
    }

    // Done, but unsigned. Refused, and said out loud.
    if (!by || !date) {
      problems.push(gate.id + ' is marked done with no "by" and no "date", so it does not count');
      gates[gate.id] = { done: false, by, date };
      continue;
    }

    gates[gate.id] = { done: true, by, date };
  }

  return { missing: false, gates, problems };
}

/**
 * One check per gate.
 *
 * An open gate is MANUAL today and FAIL on go-live day. Same list, same file,
 * one flag between "here is what is left" and "do not take money yet".
 */
export function checkGates(file: GoliveFile, expect: ExpectMode): Check[] {
  const openStatus = expect === 'live' ? 'FAIL' : 'MANUAL';
  const where = file.missing
    ? 'no web/golive.json yet'
    : 'web/golive.json';

  return GOLIVE_GATES.map((gate): Check => {
    const state = file.gates[gate.id] ?? NOT_DONE;
    const name = 'gate ' + gate.id + ' ' + gate.title;

    if (state.done) {
      return {
        name,
        status: 'PASS',
        detail: 'cleared by ' + state.by + ' on ' + state.date,
      };
    }

    return {
      name,
      status: openStatus,
      detail: 'not cleared (' + where + '); who: ' + gate.who,
      fix: gate.what + ' Then set gates.' + gate.id + ' to {"done": true, "by": "...", "date": "YYYY-MM-DD"} in web/golive.json.',
    };
  });
}

/** The file's own problems, as checks, so a typo cannot hide. */
export function checkGoliveFile(file: GoliveFile, expect: ExpectMode): Check[] {
  if (file.problems.length === 0) return [];
  return [
    {
      name: 'golive.json',
      status: expect === 'live' ? 'FAIL' : 'WARN',
      detail: file.problems.join('; '),
      fix: 'copy web/golive.example.json over web/golive.json and fill it in again',
    },
  ];
}
