'use client';

/**
 * The student's Mock test list (issue 16-set-access-mock-list).
 *
 * DESIGN.md section 8, the whole rule in one paragraph: "Set header with price
 * or 'Unlocked'. Rows: test name, score 64/200 (tabular), tick when taken,
 * button Attempt or Review. Locked rows show a lock icon and one 'Unlock
 * Rs 399' button for the whole set. Above the list: Topic dropdown (Full paper
 * by default) and a 2-way switch Practice | Exam."
 *
 * A client component, because the topic, the mode and the "payments coming
 * soon" line are all state. The rows themselves arrive already built by
 * `buildMockRows()` on the server, so no key and no access rule ships to the
 * browser.
 *
 * WHAT THIS COMPONENT IS NOT. It is not the gate. `open` on a row only decides
 * which button is drawn; a student who taps Attempt on a locked test reaches a
 * player that reads ZERO questions, because the restrictive policy in
 * `0016_set_access.sql` is the gate. Never move that rule up here.
 *
 * Unlock does not take money yet (issues 26 and 27), so it says so out loud
 * instead of opening a half-built checkout.
 */
import { Check, Lock } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ATTEMPT_MODES, type AttemptMode } from '@/lib/attempts/types';
import {
  MOCK_TOPIC_ALL,
  isTaken,
  mockPlayerPath,
  priceLabels,
  unlockLabels,
  type MockSetRow,
  type MockTopic,
} from '@/lib/set-access/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';

const CARD = 'rounded-[10px] border border-border bg-card p-3';

/** 48 px tall, the touch-target floor (DESIGN.md section 5). */
const ACTION =
  'inline-flex min-h-12 items-center gap-2 rounded-[10px] border border-primary px-3 text-base font-medium text-primary transition-colors duration-100';
const UNLOCK =
  'inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[10px] bg-primary px-3 text-base font-medium text-white transition-colors duration-100';
const FIELD =
  'min-h-12 w-full rounded-[10px] border border-border bg-card px-3 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';
const SWITCH_ON =
  'min-h-12 flex-1 rounded-[10px] border border-primary bg-primary px-3 text-base font-medium text-white';
const SWITCH_OFF =
  'min-h-12 flex-1 rounded-[10px] border border-border bg-card px-3 text-base font-medium text-foreground';
const BADGE =
  'rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground';

function Lines({ keyName, mode }: { keyName: MessageKey; mode: LangMode }) {
  return (
    <>
      {labels(keyName, mode).map((line, index) => (
        <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
          {line}
        </span>
      ))}
    </>
  );
}

export function MockList({
  sets,
  teacherId,
  topics = [],
  mode = DEFAULT_MODE,
}: {
  sets: readonly MockSetRow[];
  /** Whose portfolio this is, so the player link knows where it came from. */
  teacherId: string;
  /**
   * The topic dropdown's options. EMPTY in v1: there is no topic catalogue
   * yet, so the dropdown offers Full paper on its own (design.md: "`topics`:
   * reuse v0 `taxonomy`"). The choice still travels into the player link, so
   * issue 17-practice-mode only has to read it.
   */
  topics?: readonly MockTopic[];
  mode?: LangMode;
}) {
  const [topicId, setTopicId] = useState<string>(MOCK_TOPIC_ALL);
  const [attemptMode, setAttemptMode] = useState<AttemptMode>('practice');
  /** The set whose Unlock button was tapped, so the message sits next to it. */
  const [askedToPay, setAskedToPay] = useState<string | null>(null);

  if (sets.length === 0) {
    return (
      <p role="status" className="text-muted-foreground">
        {plain('mockList.none', mode)}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Above the list, in DESIGN.md's order: topic, then mode. */}
      <div className={`${CARD} flex flex-col gap-3`}>
        <label htmlFor="mock-topic" className="text-sm font-medium">
          <Lines keyName="mockList.topic" mode={mode} />
        </label>
        <select
          id="mock-topic"
          name="topic"
          value={topicId}
          onChange={(event) => setTopicId(event.target.value)}
          className={FIELD}
        >
          <option value={MOCK_TOPIC_ALL}>{plain('mockList.topicAll', mode)}</option>
          {topics.map((topic) => (
            <option key={topic.id} value={topic.id}>
              {topic.name}
            </option>
          ))}
        </select>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">{plain('mockList.mode', mode)}</legend>
          <div className="flex gap-2">
            {ATTEMPT_MODES.map((one) => (
              <button
                key={one}
                type="button"
                // A 2-way switch, so the pressed state is spoken, not only
                // coloured (DESIGN.md section 11).
                aria-pressed={attemptMode === one}
                onClick={() => setAttemptMode(one)}
                className={attemptMode === one ? SWITCH_ON : SWITCH_OFF}
              >
                {plain(one === 'exam' ? 'mockList.exam' : 'mockList.practice', mode)}
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      {sets.map((set) => (
        <section key={set.id} className={`${CARD} flex flex-col gap-3`}>
          <h2 className="flex flex-wrap items-center gap-2 text-[18px] leading-6 font-bold">
            <span>{set.title}</span>
            {/* Price or "Unlocked", never both. Prices are tabular. */}
            <span className={`${BADGE} tabular-nums`}>
              {priceLabels(set, mode).join(' / ')}
            </span>
          </h2>

          {set.tests.length === 0 ? (
            <p role="status" className="text-muted-foreground">
              {plain('mockList.noTests', mode)}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {set.tests.map((test) => (
                <li
                  key={test.id}
                  className="flex flex-col gap-2 border-t border-border pt-2 md:flex-row md:items-center md:justify-between"
                >
                  <span className="flex items-center gap-2">
                    {/* Locked: the lock is not colour alone, it has a name a
                        screen reader reads out. */}
                    {test.open ? null : (
                      <Lock
                        aria-label={plain('mockList.locked', mode)}
                        role="img"
                        className="size-5 text-muted-foreground"
                      />
                    )}
                    <span className="font-medium">{test.title}</span>
                    {isTaken(test) ? (
                      <>
                        <Check
                          aria-label={plain('mockList.taken', mode)}
                          role="img"
                          className="size-5 text-correct"
                        />
                        <span
                          aria-label={`${plain('mockList.score', mode)}: ${test.score}`}
                          className="tabular-nums font-medium"
                        >
                          {test.score}
                        </span>
                      </>
                    ) : null}
                  </span>

                  {/* An open test gets exactly one button: Review once it has
                      been taken, Attempt before that. A locked test gets none:
                      the set has ONE Unlock button, under the list. */}
                  {test.open ? (
                    <Link
                      href={mockPlayerPath(teacherId, test.id, {
                        mode: attemptMode,
                        topicId,
                      })}
                      prefetch={false}
                      aria-label={`${test.title}: ${plain(
                        isTaken(test) ? 'mockList.review' : 'mockList.attempt',
                        mode,
                      )}`}
                      className={ACTION}
                    >
                      <span className="flex flex-col items-start">
                        <Lines
                          keyName={isTaken(test) ? 'mockList.review' : 'mockList.attempt'}
                          mode={mode}
                        />
                      </span>
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {/* One button for the whole set, not one per row (DESIGN.md). */}
          {set.unlocked ? null : (
            <>
              <button
                type="button"
                onClick={() => setAskedToPay(set.id)}
                aria-label={unlockLabels(set.priceInr, mode).join(' / ')}
                className={`${UNLOCK} tabular-nums`}
              >
                <span className="flex flex-col items-center">
                  {unlockLabels(set.priceInr, mode).map((line, index) => (
                    <span key={line} className={index === 0 ? undefined : 'text-xs'}>
                      {line}
                    </span>
                  ))}
                </span>
              </button>
              {askedToPay === set.id ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {plain('mockList.paymentsSoon', mode)}
                </p>
              ) : null}
            </>
          )}
        </section>
      ))}
    </div>
  );
}
