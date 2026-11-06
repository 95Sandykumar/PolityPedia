'use client';

/**
 * One mock set: reprice it, add tests, add questions, publish
 * (issue 15-mock-sets-authoring).
 *
 * V11: Test 1 may be a free sample, so a student can try the teacher's style
 * before paying. The free-sample box is therefore only usable while the next
 * test is number 1, and the reason sits next to it rather than appearing as an
 * error after the teacher has already tapped Add.
 *
 * V9 again, on a mock set this time: NOTHING IS LIVE BEFORE PUBLISH, and
 * Publish stays off while any question is unchecked. The greyed-out button is
 * a courtesy; the rule is `publish_mock_set()` inside Postgres, and a stale
 * page that gets past the button is refused there and told so here.
 *
 * THE QUESTION FORM IS ISSUE 11'S, reused with a `testId` instead of a
 * `paperId`. One form means a fix to the option fields or the Checked box
 * lands on the past-paper screen and this one at the same time.
 *
 * Both browser clients are props so the tests can inject fakes: no real
 * network call and no key in any test (web/CLAUDE.md).
 */
import { Check, ChevronDown, Clock, ListChecks, Plus, Tag } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PriceStepper } from '@/components/price-stepper';
import {
  BOX,
  CARD,
  EmptyState,
  Field,
  PageHeader,
  PRIMARY_BUTTON,
  QUIET_BUTTON as QUIET,
  StatusChip,
} from '@/components/teacher-ui';
import { QuestionForm } from '@/components/teacher-review';
import { createBrowserMocksClient } from '@/lib/mocks/browser-mocks-client';
import {
  canBeFreeSample,
  DEFAULT_DURATION_MIN,
  MAX_DURATION_MIN,
  MAX_TEST_TITLE_LENGTH,
  MIN_DURATION_MIN,
  mockPublishBlock,
  nextTestPosition,
  sortTests,
  type BrowserMockSetsClient,
  type MockSet,
  type MockTest,
} from '@/lib/mocks/types';
import { createBrowserQuestionsClient } from '@/lib/questions/browser-questions-client';
import {
  nextQuestionNumber,
  sortQuestions,
  type BrowserQuestionsClient,
  type Question,
} from '@/lib/questions/types';
import { DEFAULT_MODE, plain, type LangMode, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const QUIET_BUTTON = cn(QUIET, 'text-sm text-primary');

/** A small fact on a test row: a count, a length. */
const FACT =
  'inline-flex items-center gap-1 rounded-full bg-background px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap text-muted-foreground';

/** Why Publish is off -> the line under the button. */
const BLOCK_LABELS = {
  'no-tests': 'mocks.blockedNoTests',
  unchecked: 'mocks.blockedUnchecked',
} as const satisfies Record<string, MessageKey>;

/** The code a client throws -> the one line the teacher reads. */
const PROBLEM_LABELS: Record<string, MessageKey> = {
  duplicate: 'mocks.duplicate',
  'duplicate-position': 'mocks.duplicatePosition',
  unchecked: 'mocks.blockedUnchecked',
  'no-tests': 'mocks.blockedNoTests',
  'not-found': 'mocks.notFound',
};

export function MockSetEditor({
  set,
  tests,
  questions,
  sharePct,
  client,
  questionsClient,
  mode = DEFAULT_MODE,
  configured = true,
}: {
  /** Null when there is no such set for this caller. RLS decided that. */
  set: MockSet | null;
  /** The set's tests, as the server read them. */
  tests?: readonly MockTest[];
  /** Every question across this set's tests. Drafts included. */
  questions?: readonly Question[];
  /** The teacher's own `revenue_share_pct` (X3). */
  sharePct: number;
  client?: BrowserMockSetsClient;
  questionsClient?: BrowserQuestionsClient;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const fallbackMocks = useMemo(() => createBrowserMocksClient(), []);
  const fallbackQuestions = useMemo(() => createBrowserQuestionsClient(), []);
  const data = client ?? fallbackMocks;
  const questionData = questionsClient ?? fallbackQuestions;

  const [testRows, setTestRows] = useState<MockTest[]>(() => sortTests(tests ?? []));
  const [questionRows, setQuestionRows] = useState<Question[]>(() => [
    ...(questions ?? []),
  ]);
  const [price, setPrice] = useState(set?.priceInr ?? 0);
  const [status, setStatus] = useState(set?.status ?? 'draft');

  /** Which test's questions are open. Null = none. */
  const [openTestId, setOpenTestId] = useState<string | null>(null);
  /** The question being edited inside the open test. Null = a new one. */
  const [editing, setEditing] = useState<Question | null>(null);

  const [priceBusy, setPriceBusy] = useState(false);
  const [priceDone, setPriceDone] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishDone, setPublishDone] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);

  if (!configured) {
    return (
      <Shell mode={mode} title={set?.title}>
        <p role="status" className="text-muted-foreground">
          {plain('mocks.notConfigured', mode)}
        </p>
      </Shell>
    );
  }

  if (!set) {
    return (
      <Shell mode={mode}>
        <p role="status" className="text-muted-foreground">
          {plain('mocks.notFound', mode)}
        </p>
      </Shell>
    );
  }

  // Captured once, AFTER the two guards above. The closures below read the
  // set when the teacher taps, not while this function runs, so TypeScript
  // cannot narrow the prop itself inside them.
  const open = set;
  const block = mockPublishBlock({ tests: testRows, questions: questionRows });
  const nextPosition = nextTestPosition(testRows);

  function fail(cause: unknown) {
    // Our own short code, or the generic line. Never a server message.
    const code = (cause as Error)?.message ?? '';
    setProblem(PROBLEM_LABELS[code] ?? 'mocks.failed');
  }

  async function savePrice() {
    if (priceBusy) return;
    setPriceDone(false);
    setProblem(null);
    setPriceBusy(true);
    try {
      // The id and the exam go along, so this PATCHES the same set rather than
      // creating a second one with the same name.
      const saved = await data.saveSet({
        id: open.id,
        examId: open.examId,
        title: open.title,
        priceInr: price,
      });
      setPrice(saved.priceInr);
      setPriceDone(true);
    } catch (cause) {
      fail(cause);
    } finally {
      setPriceBusy(false);
    }
  }

  async function publish() {
    if (publishBusy) return;
    setPublishDone(false);
    setProblem(null);
    setPublishBusy(true);
    try {
      await data.publish(open.id);
      setStatus('live');
      setPublishDone(true);
    } catch (cause) {
      // A refusal from `publish_mock_set()` is not a crash: the page was
      // stale, and the line tells the teacher which rule stopped them.
      fail(cause);
    } finally {
      setPublishBusy(false);
    }
  }

  const openQuestions = sortQuestions(
    questionRows.filter((one) => one.testId === openTestId),
  );

  return (
    <Shell
      mode={mode}
      title={open.title}
      action={
        // Publish is the page's main action, so it lives in the header where
        // it is always the first thing found, with the reason it is off right
        // under it. The rule itself is `publish_mock_set()` in Postgres.
        <div className="flex flex-col gap-1 sm:w-60">
          <button
            type="button"
            disabled={publishBusy || block !== null || status === 'live'}
            onClick={publish}
            className={PRIMARY_BUTTON}
          >
            {plain(publishBusy ? 'mocks.publishing' : 'mocks.publish', mode)}
          </button>

          {block ? (
            <p className="text-sm text-muted-foreground">{plain(BLOCK_LABELS[block], mode)}</p>
          ) : null}
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip live={status === 'live'}>
          {plain(status === 'live' ? 'mocks.live' : 'mocks.draft', mode)}
        </StatusChip>
      </div>

      {problem ? (
        <p role="alert" className="rounded-[10px] border border-wrong bg-wrong-soft p-3 text-wrong">
          {plain(problem, mode)}
        </p>
      ) : null}

      {publishDone ? (
        <p role="status" className="rounded-[10px] bg-primary/10 p-3 font-medium text-primary">
          {plain('mocks.published', mode)}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
      {/* ---- price ---- */}
      <section className={`${CARD} flex flex-col gap-3 lg:col-start-2 lg:row-start-1`}>
        <PriceStepper
          price={price}
          onChange={setPrice}
          sharePct={sharePct}
          mode={mode}
          busy={priceBusy}
        />
        {priceDone ? (
          <p role="status" className="text-sm font-medium text-primary">
            {plain('mocks.saved', mode)}
          </p>
        ) : null}
        <button
          type="button"
          disabled={priceBusy}
          onClick={savePrice}
          className={PRIMARY_BUTTON}
        >
          {plain(priceBusy ? 'mocks.saving' : 'mocks.savePrice', mode)}
        </button>
      </section>

      {/* ---- tests ---- */}
      <section className="flex min-w-0 flex-col gap-3 lg:col-start-1 lg:row-span-2 lg:row-start-1">
        <h2 className="flex items-baseline gap-2 text-[18px] leading-6 font-bold">
          {plain('mocks.tests', mode)}
          <span className="text-sm font-medium text-muted-foreground tabular-nums">
            {testRows.length}
          </span>
        </h2>

        {testRows.length === 0 ? (
          <EmptyState icon={ListChecks} text={plain('mocks.noTests', mode)} />
        ) : (
          <ul className="flex flex-col gap-3">
            {testRows.map((one) => {
              const count = questionRows.filter((q) => q.testId === one.id).length;
              return (
                <li key={one.id} className={`${CARD} flex flex-col gap-3`}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <span className="font-medium break-words text-foreground">{one.title}</span>
                      <span className="flex flex-wrap items-center gap-2">
                        <span className={cn(FACT, 'tabular-nums')}>
                          <Clock size={12} strokeWidth={2} aria-hidden="true" />
                          {one.durationMin} {plain('mocks.duration', mode)}
                        </span>
                        <span
                          data-testid={`question-count-${one.id}`}
                          className={cn(FACT, 'tabular-nums')}
                        >
                          {count} {plain('mocks.questions', mode)}
                        </span>
                        {one.isFreeSample ? (
                          // A testid as well as the words, because the same
                          // words are the label of the checkbox below.
                          <span
                            data-testid={`free-sample-${one.id}`}
                            className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap text-primary"
                          >
                            <Tag size={12} strokeWidth={2} aria-hidden="true" />
                            {plain('mocks.freeSample', mode)}
                          </span>
                        ) : null}
                      </span>
                    </div>

                    <button
                      type="button"
                      aria-expanded={openTestId === one.id}
                      onClick={() => {
                        setOpenTestId(openTestId === one.id ? null : one.id);
                        setEditing(null);
                      }}
                      className={cn(QUIET_BUTTON, 'shrink-0 border-primary')}
                    >
                      {plain('mocks.questions', mode)}
                      <ChevronDown
                        size={20}
                        strokeWidth={2}
                        aria-hidden="true"
                        className={cn(
                          'transition-transform duration-200',
                          openTestId === one.id && 'rotate-180',
                        )}
                      />
                    </button>
                  </div>

                  {openTestId === one.id ? (
                    <div className="flex flex-col gap-2">
                      {/* The questions already in this test, each a door back
                          into the form. The number and the Checked state are
                          all a teacher needs to find the one they want. */}
                      {openQuestions.length > 0 ? (
                        <ul className="flex flex-wrap gap-2">
                          {openQuestions.map((q) => (
                            <li key={q.id}>
                              <button
                                type="button"
                                onClick={() => setEditing(q)}
                                aria-current={editing?.id === q.id ? 'step' : undefined}
                                aria-label={`${plain('review.question', mode)} ${q.number}, ${plain(
                                  q.checked ? 'review.checked' : 'review.draft',
                                  mode,
                                )}`}
                                className={cn(
                                  'relative flex min-h-12 min-w-12 items-center justify-center rounded-[10px] border px-2 text-base font-bold tabular-nums transition-colors duration-100',
                                  editing?.id === q.id
                                    ? 'border-primary bg-primary text-primary-foreground'
                                    : q.checked
                                      ? 'border-correct bg-correct-soft text-correct'
                                      : 'border-border bg-card text-foreground hover:bg-background',
                                )}
                              >
                                {q.number}
                                {q.checked ? (
                                  <Check
                                    size={12}
                                    strokeWidth={3}
                                    aria-hidden="true"
                                    className="absolute top-1 right-1"
                                  />
                                ) : null}
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}

                      {/* Issue 11's form, with the OTHER parent. */}
                      <QuestionForm
                        // The key resets every field when the teacher moves to
                        // another question, so no edit leaks into the next.
                        key={editing?.id ?? `new-${one.id}-${openQuestions.length}`}
                        parent={{ testId: one.id }}
                        question={editing}
                        fallbackNumber={nextQuestionNumber(openQuestions)}
                        client={questionData}
                        mode={mode}
                        onSaved={(saved) => {
                          setQuestionRows((current) => {
                            const at = current.findIndex((q) => q.id === saved.id);
                            if (at === -1) return [...current, saved];
                            const next = [...current];
                            next[at] = saved;
                            return next;
                          });
                          setEditing(null);
                        }}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ---- add a test ---- */}
      <AddTestForm
        setId={open.id}
        position={nextPosition}
        client={data}
        mode={mode}
        onProblem={setProblem}
        onAdded={(made) => setTestRows((current) => sortTests([...current, made]))}
      />
      </div>
    </Shell>
  );
}

/**
 * Add one test to the set.
 *
 * The POSITION is offered, not asked for: it is one past the highest one
 * already there, so a deleted Test 2 never causes a clash with
 * `mock_tests_set_position_idx`. The teacher may still change it, because a
 * set built out of order is their business.
 *
 * The free-sample box is only usable while the position is 1 (V11), and the
 * reason is on the screen next to it rather than arriving as an error.
 */
function AddTestForm({
  setId,
  position: suggested,
  client,
  mode,
  onAdded,
  onProblem,
}: {
  setId: string;
  position: number;
  client: BrowserMockSetsClient;
  mode: LangMode;
  onAdded: (made: MockTest) => void;
  onProblem: (problem: MessageKey | null) => void;
}) {
  const [title, setTitle] = useState('');
  const [position, setPosition] = useState(String(suggested));
  const [durationMin, setDurationMin] = useState(String(DEFAULT_DURATION_MIN));
  const [isFreeSample, setIsFreeSample] = useState(false);
  const [busy, setBusy] = useState(false);

  const free = canBeFreeSample(Number(position));

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    onProblem(null);

    const clean = title.trim();
    if (clean.length === 0) {
      onProblem('mocks.needName');
      return;
    }

    setBusy(true);
    try {
      const made = await client.saveTest(setId, {
        title: clean,
        position: Number(position),
        durationMin: Number(durationMin),
        // Fails closed: a box that cannot be ticked never sends `true`.
        isFreeSample: free && isFreeSample,
      });
      onAdded(made);
      setTitle('');
      setPosition(String(made.position + 1));
      setIsFreeSample(false);
    } catch (cause) {
      const code = (cause as Error)?.message ?? '';
      onProblem(PROBLEM_LABELS[code] ?? 'mocks.failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={add}
      className={`${CARD} flex flex-col gap-3 lg:col-start-2 lg:row-start-2`}
      noValidate
    >
      <h2 className="flex items-center gap-2 text-[18px] leading-6 font-bold">
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary"
        >
          <Plus size={20} strokeWidth={2} />
        </span>
        {plain('mocks.addTest', mode)}
      </h2>

      <Field labelKey="mocks.testName" mode={mode}>
        <input
          type="text"
          value={title}
          maxLength={MAX_TEST_TITLE_LENGTH}
          aria-label={plain('mocks.testName', mode)}
          onChange={(event) => setTitle(event.target.value)}
          className={BOX}
        />
      </Field>

      <div className="flex flex-col gap-3 md:flex-row">
        <Field labelKey="mocks.testNumber" mode={mode}>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={position}
            aria-label={plain('mocks.testNumber', mode)}
            onChange={(event) => setPosition(event.target.value)}
            className={`${BOX} tabular-nums`}
          />
        </Field>

        <Field labelKey="mocks.duration" mode={mode}>
          <input
            type="number"
            inputMode="numeric"
            min={MIN_DURATION_MIN}
            max={MAX_DURATION_MIN}
            value={durationMin}
            aria-label={plain('mocks.duration', mode)}
            onChange={(event) => setDurationMin(event.target.value)}
            className={`${BOX} tabular-nums`}
          />
        </Field>
      </div>

      <label className="flex min-h-12 items-center gap-2">
        <input
          type="checkbox"
          checked={free && isFreeSample}
          disabled={!free}
          aria-label={plain('mocks.freeSample', mode)}
          onChange={(event) => setIsFreeSample(event.target.checked)}
          className="h-5 w-5 accent-primary"
        />
        <span className="text-base text-foreground">
          {plain('mocks.freeSample', mode)}
        </span>
      </label>

      {/* Only shown when the box is off, so it reads as the reason and not as
          a rule the teacher is about to break. */}
      {!free ? (
        <p className="text-sm text-muted-foreground">
          {plain('mocks.freeSampleHint', mode)}
        </p>
      ) : null}

      <button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
        {plain(busy ? 'mocks.saving' : 'mocks.addTest', mode)}
      </button>
    </form>
  );
}


/** The page frame: the set title as the heading, or the screen name. */
function Shell({
  mode,
  title,
  action,
  children,
}: {
  mode: LangMode;
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const back = { href: '/teacher/mocks', label: plain('nav.mockSets', mode) };
  return (
    <section className="flex flex-col gap-4">
      {title ? (
        <PageHeader title={title} mode={mode} icon={ListChecks} back={back} action={action} />
      ) : (
        <PageHeader titleKey="mocks.title" mode={mode} icon={ListChecks} back={back} />
      )}
      {children}
    </section>
  );
}
