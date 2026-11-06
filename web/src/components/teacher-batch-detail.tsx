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
import { Gift, Users, UserX } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  CARD as PANEL,
  EmptyState,
  Lines,
  PageHeader,
  StatusChip,
} from '@/components/teacher-ui';
import { createBrowserBatchesClient } from '@/lib/batches/browser-batches-client';
import {
  joinLink,
  type Batch,
  type BatchMember,
  type BrowserBatchesClient,
} from '@/lib/batches/types';
import { DEFAULT_MODE, plain, type LangMode, type MessageKey } from '@/lib/i18n';
import type { MockSet } from '@/lib/mocks/types';

const CARD = PANEL;

const QUIET_BUTTON =
  'inline-flex min-h-12 items-center justify-center gap-2 rounded-[10px] border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors duration-100 hover:bg-background disabled:opacity-60';

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
        <PageHeader
          titleKey="batches.title"
          mode={mode}
          icon={Users}
          back={{ href: '/teacher/batches', label: plain('nav.batches', mode) }}
        />
        <EmptyState icon={UserX} text={plain('batches.notFound', mode)} />
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
      <div className="flex flex-col gap-3">
        <PageHeader
          title={batch.name}
          mode={mode}
          icon={Users}
          back={{ href: '/teacher/batches', label: plain('nav.batches', mode) }}
        />
        <div className={`${CARD} flex flex-col gap-1 p-4`}>
          <span className="text-sm font-medium text-muted-foreground">
            {plain('batches.code', mode)}
          </span>
          <span className="font-mono text-2xl leading-8 font-bold tracking-widest text-foreground">
            {batch.joinCode}
          </span>
          {/* The whole link, so a teacher on a laptop can select it by hand. */}
          <span className="break-all text-sm text-muted-foreground">
            {joinLink(origin, batch.joinCode)}
          </span>
        </div>
      </div>

      {problem ? (
        <p role="alert" className={`${CARD} text-wrong`}>
          {plain(problem, mode)}
        </p>
      ) : null}

      <section className="flex flex-col gap-3">
        <Heading labelKey="batches.students" mode={mode} count={roll.length} />
        {roll.length === 0 ? (
          <EmptyState icon={UserX} text={plain('batches.noStudents', mode)} />
        ) : (
          <ul className="flex flex-col gap-2">
            {roll.map((one) => (
              <li
                key={one.userId}
                className={`${CARD} flex items-center justify-between gap-3`}
              >
                {/* The id, not a name: v1 reads no other user's profile. */}
                <span className="flex min-w-0 items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
                  >
                    <Users size={20} strokeWidth={2} />
                  </span>
                  <span className="break-all font-mono text-xs text-muted-foreground">
                    {one.userId}
                  </span>
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
        <p className="text-sm text-muted-foreground">{plain('batches.setsHint', mode)}</p>

        {sets.length === 0 ? (
          <EmptyState icon={Gift} text={plain('batches.noSets', mode)} />
        ) : (
          <ul className="flex flex-col gap-2">
            {sets.map((set) => (
              <li key={set.id} className={CARD}>
                <label className="flex min-h-12 items-center justify-between gap-3">
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="font-medium break-words text-foreground">{set.title}</span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums text-sm font-bold">
                        {'₹' + set.priceInr}
                      </span>
                      <StatusChip live={set.status === 'live'}>
                        {plain(set.status === 'live' ? 'mocks.live' : 'mocks.draft', mode)}
                      </StatusChip>
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

function Heading({
  labelKey,
  mode,
  count,
}: {
  labelKey: MessageKey;
  mode: LangMode;
  count?: number;
}) {
  return (
    <h2 className="flex items-baseline gap-2 text-[18px] leading-6 font-bold text-foreground">
      <span>
        <Lines keyName={labelKey} mode={mode} sub="text-sm font-medium text-muted-foreground" />
      </span>
      {count !== undefined ? (
        <span className="text-sm font-medium text-muted-foreground tabular-nums">{count}</span>
      ) : null}
    </h2>
  );
}
