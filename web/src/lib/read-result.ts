/**
 * "Ok but empty" is not the same as "failed" (issue 54a-read-error-core).
 *
 * Every student reader used to end in `.catch(() => [])`, and the Supabase
 * clients end in `if (!res.ok) return []`. So a broken read and a teacher who
 * has not uploaded anything yet arrived at the screen looking identical, and
 * the screen said the friendly thing: "No mock tests yet. Your teacher adds
 * them soon." A missing `archived_at` column once hid live content that way.
 *
 * This file is the smallest fix for that: one result type, plus a probe that
 * notices a failure WITHOUT changing a single Supabase client or a single
 * query. The probe is a `fetch` wrapper handed to the client in place of
 * `fetch`; it records any non-ok status or thrown request, so after the client
 * has quietly turned a 400 into `[]`, the reader can still tell what happened.
 *
 * Nothing here reads `fetch`, env or Supabase at import time, so the build
 * still works with no environment variables (web/CLAUDE.md).
 */

/**
 * The outcome of one student read.
 *
 * `{ ok: true, data: [] }` means the read worked and there is nothing to show:
 * the screen shows its empty state. `{ ok: false }` means the read failed: the
 * screen shows the shared error state and offers Retry. There is no `data` on
 * a failure on purpose, so a caller cannot accidentally render a list that was
 * never read.
 */
export type ReadResult<T> = { ok: true; data: T } | { ok: false };

/** A read that worked. Zero rows is still a success. */
export function readOk<T>(data: T): ReadResult<T> {
  return { ok: true, data };
}

/** A read that failed. The caller shows the error state, never the empty one. */
export function readFailed<T = never>(): ReadResult<T> {
  return { ok: false };
}

/** A `fetch` stand-in that remembers whether any request failed. */
export interface ReadProbe {
  /** Hand this to a Supabase client in place of `fetch`. */
  fetchImpl: typeof fetch;
  /** True once a request answered a non-ok status, or threw. */
  failed(): boolean;
}

/**
 * A fresh probe. `base` is the real fetch to call through to, injected in
 * tests; left out, it uses the global `fetch` LAZILY, at call time.
 */
export function createReadProbe(base?: typeof fetch): ReadProbe {
  let failed = false;

  const fetchImpl: typeof fetch = async (...args) => {
    try {
      const res = await (base ?? fetch)(...args);
      // A 404 on a REST collection is a broken URL, not an empty table, so
      // every non-ok status counts. The status itself never reaches the UI.
      if (!res.ok) failed = true;
      return res;
    } catch (error) {
      failed = true;
      throw error;
    }
  };

  return { fetchImpl, failed: () => failed };
}

/**
 * Run a read with a probe and report what really happened.
 *
 * `run` gets the probe's `fetchImpl` and should pass it straight to the
 * Supabase client it builds. If any request inside failed, or `run` itself
 * threw, the answer is `{ ok: false }` even when `run` returned rows.
 */
export async function readWithProbe<T>(
  run: (fetchImpl: typeof fetch) => Promise<T>,
  base?: typeof fetch,
): Promise<ReadResult<T>> {
  const probe = createReadProbe(base);
  try {
    const data = await run(probe.fetchImpl);
    return probe.failed() ? readFailed<T>() : readOk(data);
  } catch {
    // The reason is deliberately dropped here. It is a server-side detail and
    // the student's message names no table, column or key.
    return readFailed<T>();
  }
}
