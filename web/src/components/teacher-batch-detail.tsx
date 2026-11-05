'use client';

/**
 * One batch's own page: the code, the students, the free sets
 * (issue 19-batches).
 *
 * V2 "Teacher can remove a student" and V3 "teacher picks which of their mock
 * sets a batch gets free" are the two writes on this screen. Neither of them
 * touches `set_access`: the triggers in `0019_batches.sql` do that in the same
 * transaction, so a tick here IS the grant and there is no second step to
 * forget.
 *
 * A removed student disappears from the list at once, and a failed remove puts
 * them back, because a row that vanished on a failed request is a teacher who
 * thinks they removed somebody who is still reading their paid sets.
 *
 * The same rule holds for the free-set toggle: it flips back when the save
 * fails.
 *
 * NO STUDENT NAMES. v1 reads no other user's profile row
 * (`profiles_select_own`), so the roll shows the user id. An honest id beats a
 * made-up name, and a report with names is issue 20's problem.
 *
 * The `BrowserBatchesClient` is a prop so the test can inject a fake: no real
 * network call and no key in any test (web/CLAUDE.md).
 */
import { useMemo, useState } from 'react';
import { createBrowserBatchesClient } from '@/lib/batches/browser-batches-client';
import {
  joinLink,
  type Batch,
  type BatchMember,
  type BrowserBatchesClient,
} from '@/lib/batches/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';
import type { MockSet } from '@/lib/mocks/types';

const CARD = 'rounded-[10px] border border-border bg-card p-3';

const QUIET_BUTTON =
  'min-h-12 rounded-[10px] border border-border px-3 text-sm font-medium text-primary disabled:opacity-60';

const BADGE = 'rounded-full border border-border px-2 py-0.5 text-xs font-medium';

export function TeacherBatchDetail({
  batch,
  members,
  sets,
  freeSetIds,
  origin,
  client,
  mode = DEFAULT_MODE,
}: {
  /** Null when RLS hid the row: somebody else's batch, or none at all. */
  batch: Batch | null;
  members: readonly BatchMember[];
  /** The teacher's own mock sets, drafts included: a draft can be queued up. */
  sets: readonly MockSet[];
  /** Which of those sets this batch already gives away. */
  freeSetIds: readonly string[];
  origin: string;
  client?: BrowserBatchesClient;
  mode?: LangMode;
}) {
  const fallback = useMemo(() => createBrowserBatchesClient(), []);
  const data = client ?? fallback;

  const [roll, setRoll] = useState<BatchMember[]>(() => [...members]);
  const [free, setFree] = useState<Set<string>>(() => new Set(freeSetIds));
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [busySet, setBusySet] = useState<string | null>(null);
  const [problem, setProblem] = useState<MessageKey | null>(null);

  if (!batch) {
    return (
      <section className="flex flex-col gap-3">
        <p role="status" className="text-muted-foreground">
          {plain('batches.notFound', mode)}
        </p>
      </section>
    );
  }

  const id = batch.id;

  async function remove(userId: string) {
    if (busyUser) return;
    setProblem(null);
    setBusyUser(userId);
    try {
      await data.removeMember(id, userId);
      setRoll((current) => current.filter((one) => one.userId !== userId));
    } catch {
      // The row stays. A student who is still in the batch must still look
      // like one.
      setProblem('batches.removeFailed');
    } finally {
      setBusyUser(null);
    }
  }

  async function toggle(setId: string, next: boolean) {
    if (busySet) return;
    setProblem(null);
    setBusySet(setId);

    // Optimistic, then put back on failure: on 4G the teacher should see the
    // tick move at once.
    setFree((current) => {
      const copy = new Set(current);
      if (next) copy.add(setId);
      else copy.delete(setId);
      return copy;
    });

    try {
      await data.setFree(id, setId, next);
    } catch {
      setFree((current) => {
        const copy = new Set(current);
        if (next) copy.delete(setId);
        else copy.add(setId);
        return copy;
      });
      setProblem('batches.failed');
    } finally {
      setBusySet(null);
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold text-foreground">{batch.name}</h1>
        <div className={`${CARD} flex flex-col gap-1`}>
          <span className="text-xs text-muted-foreground">{plain('batches.code', mode)}</span>
          <span className="font-mono text-lg tracking-widest text-foreground">
            {batch.joinCode}
          </span>
          {/* The whole link, so a teacher on a laptop can select it by hand. */}
          <span className="break-all text-xs text-muted-foreground">
            {joinLink(origin, batch.joinCode)}
          </span>
        </div>
      </header>

      {problem ? (
        <p role="alert" className={`${CARD} text-wrong`}>
          {plain(problem, mode)}
        </p>
      ) : null}

      <section className="flex flex-col gap-3">
        <Heading labelKey="batches.students" mode={mode} />
        {roll.length === 0 ? (
          <p className="text-muted-foreground">{plain('batches.noStudents', mode)}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {roll.map((one) => (
              <li
                key={one.userId}
                className={`${CARD} flex items-center justify-between gap-3`}
              >
                {/* The id, not a name: v1 reads no other user's profile. */}
                <span className="break-all font-mono text-xs text-muted-foreground">
                  {one.userId}
                </span>
                <button
                  type="button"
                  onClick={() => remove(one.userId)}
                  disabled={busyUser !== null}
                  className={`${QUIET_BUTTON} shrink-0`}
                >
                  {plain(busyUser === one.userId ? 'batches.removing' : 'batches.remove', mode)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <Heading labelKey="batches.freeSets" mode={mode} />
        <p className="text-muted-foreground">{plain('batches.setsHint', mode)}</p>

        {sets.length === 0 ? (
          <p className="text-muted-foreground">{plain('batches.noSets', mode)}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {sets.map((set) => (
              <li key={set.id} className={CARD}>
                <label className="flex items-center justify-between gap-3">
                  <span className="flex flex-col gap-1">
                    <span className="font-medium text-foreground">{set.title}</span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums text-sm font-medium">
                        {'₹' + set.priceInr}
                      </span>
                      <span className={BADGE}>
                        {plain(set.status === 'live' ? 'mocks.live' : 'mocks.draft', mode)}
                      </span>
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={free.has(set.id)}
                    disabled={busySet !== null}
                    aria-label={set.title}
                    onChange={(event) => toggle(set.id, event.target.checked)}
                    className="size-6 shrink-0 accent-primary"
                  />
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function Heading({ labelKey, mode }: { labelKey: MessageKey; mode: LangMode }) {
  return (
    <h2 className="text-base font-semibold text-foreground">
      {labels(labelKey, mode).map((line, index) => (
        <span key={line} className={index === 0 ? 'block' : 'block text-sm font-normal'}>
          {line}
        </span>
      ))}
    </h2>
  );
}
