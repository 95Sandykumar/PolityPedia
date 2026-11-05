'use client';

/**
 * Teacher review: the PDF page beside the question form, then Publish
 * (issue 11-ingest-job-review-publish).
 *
 * PRD F-D3 and DESIGN.md section 8: "on a laptop, the PDF page on the left and
 * the question form on the right; on a phone, a tab switch 'PDF | Question'.
 * Each question shows Draft / Checked. Publish stays disabled until every
 * question is checked."
 *
 * V9 and Risk 1 are why the Publish button is the careful part. It is greyed
 * out while the split still runs or while one question is unchecked, and the
 * reason is written under it, because a disabled button with no reason is the
 * worst state in this whole app. The button is NOT the gate though:
 * `publish_paper()` checks the same two things inside Postgres, and
 * `questions_live_is_checked_check` makes a live unchecked question impossible
 * whatever the browser sends.
 *
 * B6: the job status arrives over the `Live` interface (Supabase Realtime in
 * production, a fake in tests). There is no timer in this file.
 *
 * Both panels are always in the DOM. The tab buttons are `md:hidden`, and each
 * panel is `hidden md:block` when its tab is not the open one, so the laptop
 * shows two columns and the phone shows one. One tree, no duplicated form.
 *
 * The browser client and the `Live` stream are props so the test injects
 * fakes: no real network call, no socket and no key (web/CLAUDE.md).
 */
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { paperDownloadPath, type Paper } from '@/lib/papers/types';
import { createBrowserQuestionsClient } from '@/lib/questions/browser-questions-client';
import { createMemoryLive } from '@/lib/questions/memory-live';
import { createSupabaseLive } from '@/lib/questions/supabase-live';
import {
  MAX_QUESTIONS_PER_PAPER,
  OPTION_COUNT,
  isJobBusy,
  nextQuestionNumber,
  publishBlock,
  readOptions,
  sortQuestions,
  type BrowserQuestionsClient,
  type IngestJob,
  type IngestJobStatus,
  type Live,
  type Question,
} from '@/lib/questions/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';

const PRIMARY_BUTTON =
  'min-h-12 w-full rounded-[10px] bg-primary px-3 text-base font-medium text-primary-foreground transition-colors duration-100 disabled:opacity-60';

const QUIET_BUTTON =
  'min-h-12 flex-1 rounded-[10px] border border-border bg-card px-3 text-base font-medium text-foreground transition-colors duration-100 disabled:opacity-60';

const BOX =
  'min-h-12 w-full rounded-[10px] border border-border bg-card px-3 py-2 text-base text-foreground';

const CARD = 'rounded-[10px] border border-border bg-card p-3';

const BADGE = 'rounded-full border border-border px-2 py-0.5 text-xs font-medium';

/** One line per job status. Same five words in both languages. */
const JOB_LABELS: Record<IngestJobStatus, MessageKey> = {
  queued: 'job.queued',
  running: 'job.running',
  done: 'job.done',
  failed: 'job.failed',
};

/** Why Publish is off -> the line under the button. */
const BLOCK_LABELS = {
  splitting: 'review.blockedSplitting',
  unchecked: 'review.blockedUnchecked',
} as const satisfies Record<string, MessageKey>;

/** The code the browser client throws -> the one line the teacher reads. */
const PROBLEM_LABELS: Record<string, MessageKey> = {
  'duplicate-number': 'review.duplicateNumber',
  unchecked: 'review.blockedUnchecked',
  splitting: 'review.blockedSplitting',
  'not-found': 'review.notFound',
};

/** The four option fields, in A B C D order. */
const OPTION_KEYS = [
  'review.optionA',
  'review.optionB',
  'review.optionC',
  'review.optionD',
] as const satisfies readonly MessageKey[];

const OPTION_LETTERS = ['A', 'B', 'C', 'D'] as const;

type Tab = 'pdf' | 'question';

export function TeacherReview({
  paper,
  questions,
  job: serverJob,
  client,
  live,
  mode = DEFAULT_MODE,
  configured = true,
}: {
  /** Null when there is no such paper for this caller. RLS decided that. */
  paper: Paper | null;
  /** The paper's questions, as the server read them. Drafts included. */
  questions?: readonly Question[];
  /** The split job as the server read it, or null when it was never queued. */
  job: IngestJob | null;
  client?: BrowserQuestionsClient;
  live?: Live;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const router = useRouter();

  const fallbackClient = useMemo(() => createBrowserQuestionsClient(), []);
  const data = client ?? fallbackClient;

  // With no keys there is nothing to watch, so an empty stream is the right
  // answer rather than a null check at the call site.
  const fallbackLive = useMemo(
    () => (configured ? createSupabaseLive({ accessToken: '' }) : createMemoryLive().live),
    [configured],
  );
  const stream = live ?? fallbackLive;

  const [rows, setRows] = useState<Question[]>(() => sortQuestions(questions ?? []));
  const [at, setAt] = useState(0);
  const [job, setJob] = useState<IngestJob | null>(serverJob);
  const [tab, setTab] = useState<Tab>('question');
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);

  const jobId = serverJob?.id ?? null;

  // B6: the job row is PUSHED. No interval, no "is it done yet" request.
  useEffect(() => {
    if (!jobId) return;
    return stream.watchJob(jobId, (next) => {
      setJob(next);
      // The split is over, so the questions are in Postgres but not in this
      // page. Ask the server component to read them again; that keeps ONE
      // place that knows how to read a question (the server).
      if (!isJobBusy(next.status)) router.refresh();
    });
    // `stream` and `router` are stable for the life of the screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  if (!configured) {
    return (
      <section className="flex flex-col gap-3">
        <Title mode={mode} />
        <p role="status" className="text-muted-foreground">
          {plain('review.notConfigured', mode)}
        </p>
      </section>
    );
  }

  if (!paper) {
    return (
      <section className="flex flex-col gap-3">
        <Title mode={mode} />
        <p role="status" className="text-muted-foreground">
          {plain('review.notFound', mode)}
        </p>
      </section>
    );
  }

  const current = rows[at] ?? null;
  const block = publishBlock({ job, questions: rows });

  function onSaved(saved: Question) {
    setRows((old) => {
      const without = old.filter((one) => one.id !== saved.id);
      const next = sortQuestions([...without, saved]);
      // Follow the row, so a question that was renumbered stays on screen.
      setAt(Math.max(0, next.findIndex((one) => one.id === saved.id)));
      return next;
    });
  }

  async function publish() {
    if (publishing || !paper) return;
    setProblem(null);
    setPublished(false);
    setPublishing(true);
    try {
      await data.publish(paper.id);
      setPublished(true);
      // The paper and its questions are live now, so re-read the server data.
      router.refresh();
    } catch (cause) {
      // Our own short code, or the generic line. Never a server message.
      const code = (cause as Error)?.message ?? '';
      setProblem(PROBLEM_LABELS[code] ?? 'review.failed');
    } finally {
      setPublishing(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <Title mode={mode} />
      <p className="text-muted-foreground">{plain('review.hint', mode)}</p>

      {job ? <JobLine job={job} mode={mode} /> : null}

      {/* Phone only: DESIGN.md section 8. The laptop shows both columns. */}
      <div role="tablist" aria-label={plain('review.title', mode)} className="flex gap-2 md:hidden">
        {(['pdf', 'question'] as const).map((which) => (
          <button
            key={which}
            type="button"
            role="tab"
            aria-selected={tab === which}
            onClick={() => setTab(which)}
            className={`${QUIET_BUTTON} ${tab === which ? 'border-primary text-primary' : ''}`}
          >
            {plain(which === 'pdf' ? 'review.tabPdf' : 'review.tabQuestion', mode)}
          </button>
        ))}
      </div>

      {/* 1120 px and two columns on the teacher dashboard (DESIGN.md 5). */}
      <div className="grid gap-3 md:grid-cols-2">
        <div className={tab === 'pdf' ? 'flex flex-col gap-2' : 'hidden md:flex md:flex-col md:gap-2'}>
          <PdfPanel paper={paper} mode={mode} />
        </div>

        <div
          className={
            tab === 'question' ? 'flex flex-col gap-3' : 'hidden md:flex md:flex-col md:gap-3'
          }
        >
          <Walker
            at={at}
            total={rows.length}
            current={current}
            mode={mode}
            onGo={(next) => {
              setProblem(null);
              setAt(next);
            }}
            onAdd={() => {
              setProblem(null);
              // One past the end: an index with no row behind it is the blank
              // "new question" form.
              setAt(rows.length);
            }}
          />

          {rows.length === 0 && at === 0 ? (
            <p role="status" className="text-muted-foreground">
              {plain('review.none', mode)}
            </p>
          ) : null}

          <QuestionForm
            // The key resets every field when the teacher moves to another
            // question, so no edit can leak from one row into the next.
            key={current?.id ?? `new-${at}`}
            parent={{ paperId: paper.id }}
            question={current}
            fallbackNumber={nextQuestionNumber(rows)}
            client={data}
            mode={mode}
            onSaved={onSaved}
          />
        </div>
      </div>

      {problem ? (
        <p role="alert" className={`${CARD} text-wrong`}>
          {plain(problem, mode)}
        </p>
      ) : null}

      {published ? (
        <p role="status" className="text-muted-foreground">
          {plain('review.published', mode)}
        </p>
      ) : null}

      <button
        type="button"
        onClick={publish}
        disabled={publishing || block !== null}
        className={PRIMARY_BUTTON}
      >
        {plain(publishing ? 'review.publishing' : 'review.publish', mode)}
      </button>

      {/* A disabled button always says why. */}
      {block ? (
        <p className="text-sm text-muted-foreground">{plain(BLOCK_LABELS[block], mode)}</p>
      ) : null}
    </section>
  );
}

/** The live job line: one status word, the count so far, and any error. */
function JobLine({ job, mode }: { job: IngestJob; mode: LangMode }) {
  return (
    <div className={`${CARD} flex flex-col gap-1`} aria-live="polite">
      <span className="font-medium">{plain(JOB_LABELS[job.status], mode)}</span>
      {job.questionCount > 0 ? (
        <span className="text-sm text-muted-foreground tabular-nums">
          {job.questionCount} {plain('job.found', mode)}
        </span>
      ) : null}
      {/* The splitter's own words. The teacher can act on them; we cannot. */}
      {job.error ? <span className="text-sm text-wrong">{job.error}</span> : null}
    </div>
  );
}

/**
 * The PDF page itself. An `<iframe>` of OUR download route, so the browser's
 * built-in PDF viewer does the paging and we ship no PDF library on 4G
 * (DESIGN.md section 10). The link under it is the way out for a phone whose
 * browser will not render a PDF inline.
 */
function PdfPanel({ paper, mode }: { paper: Paper; mode: LangMode }) {
  if (!paper.questionsPath) {
    return <p className="text-muted-foreground">{plain('review.noPdf', mode)}</p>;
  }

  const href = paperDownloadPath(paper.id, 'questions');
  return (
    <>
      <iframe
        src={href}
        title={plain('review.openPdf', mode)}
        className="h-[60vh] w-full rounded-[10px] border border-border bg-card md:h-[70vh]"
      />
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="min-h-12 inline-flex items-center text-base font-medium text-primary"
      >
        {plain('review.openPdf', mode)}
      </a>
    </>
  );
}

/** Where the teacher is, the Draft / Checked badge, and the three moves. */
function Walker({
  at,
  total,
  current,
  mode,
  onGo,
  onAdd,
}: {
  at: number;
  total: number;
  current: Question | null;
  mode: LangMode;
  onGo: (next: number) => void;
  onAdd: () => void;
}) {
  // `at` can sit one past the end: that is the blank new question, and it
  // counts as a position so the teacher is not told "question 4 of 3".
  const shown = Math.max(total, at + 1);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-muted-foreground tabular-nums">
          {plain('review.question', mode)} {at + 1} {plain('review.of', mode)} {shown}
        </span>
        <span
          className={`${BADGE} ${
            current?.checked ? 'border-correct text-correct' : 'text-muted-foreground'
          }`}
        >
          {plain(current?.checked ? 'review.checked' : 'review.draft', mode)}
        </span>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onGo(at - 1)}
          disabled={at === 0}
          className={QUIET_BUTTON}
        >
          {plain('review.prev', mode)}
        </button>
        <button
          type="button"
          onClick={() => onGo(at + 1)}
          disabled={at + 1 >= shown}
          className={QUIET_BUTTON}
        >
          {plain('review.next', mode)}
        </button>
      </div>

      <button
        type="button"
        onClick={onAdd}
        disabled={total >= MAX_QUESTIONS_PER_PAPER}
        className={QUIET_BUTTON}
      >
        {plain('review.add', mode)}
      </button>
    </div>
  );
}

/**
 * One question. Owns its own field state; the caller resets it with a `key`.
 *
 * `question` is null for a question the teacher is adding by hand, and then
 * the save goes out with `id: null` so the server inserts instead of patching.
 *
 * EXPORTED since issue 15-mock-sets-authoring: the mock set screen reuses this
 * exact form with a `testId` instead of a `paperId`. One form, so a fix to the
 * option fields or the Checked box lands on both screens at once.
 */
export function QuestionForm({
  parent,
  question,
  fallbackNumber,
  client,
  mode,
  onSaved,
}: {
  /**
   * Which parent the question hangs on: a past paper OR a mock test, never
   * both. The union makes `questions_one_parent_check` unrepresentable here,
   * so a caller cannot pass two parents or none.
   */
  parent: { paperId: string; testId?: never } | { testId: string; paperId?: never };
  question: Question | null;
  /** The number a NEW question gets: one past the highest one in the paper. */
  fallbackNumber: number;
  client: BrowserQuestionsClient;
  mode: LangMode;
  onSaved: (saved: Question) => void;
}) {
  const [number, setNumber] = useState(String(question?.number ?? fallbackNumber));
  const [stem, setStem] = useState(question?.stem ?? '');
  const [options, setOptions] = useState<string[]>(() =>
    question ? [...question.options] : Array.from({ length: OPTION_COUNT }, () => ''),
  );
  const [correctIdx, setCorrectIdx] = useState(question?.correctIdx ?? 0);
  const [explanation, setExplanation] = useState(question?.teacherExplanation ?? '');
  const [checked, setChecked] = useState(question?.checked ?? false);

  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setDone(false);
    setProblem(null);

    // Asked here as well as in the route, so a teacher who deleted a line
    // gets the answer with no request at all.
    if (stem.trim().length === 0) {
      setProblem('review.needStem');
      return;
    }
    const clean = readOptions(options);
    if (!clean) {
      setProblem('review.needOptions');
      return;
    }

    setBusy(true);
    try {
      const saved = await client.save({
        id: question?.id ?? null,
        // Exactly one of the two is a string; the other is sent as an explicit
        // null, which is the XOR the database checks.
        paperId: parent.paperId ?? null,
        testId: parent.testId ?? null,
        number: Number(number),
        stem: stem.trim(),
        options: clean,
        correctIdx,
        teacherExplanation: explanation.trim().length > 0 ? explanation.trim() : null,
        // One question is written in one language. `both` is a display mode.
        lang: question?.lang ?? (mode === 'hi' ? 'hi' : 'en'),
        checked,
      });
      setDone(true);
      onSaved(saved);
    } catch (cause) {
      const code = (cause as Error)?.message ?? '';
      setProblem(PROBLEM_LABELS[code] ?? 'review.failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className={`${CARD} flex flex-col gap-3`} noValidate>
      {problem ? (
        <p role="alert" className="text-wrong">
          {plain(problem, mode)}
        </p>
      ) : null}

      <Field labelKey="review.number" mode={mode}>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_QUESTIONS_PER_PAPER}
          value={number}
          aria-label={plain('review.number', mode)}
          onChange={(event) => setNumber(event.target.value)}
          className={`${BOX} tabular-nums`}
        />
      </Field>

      <Field labelKey="review.stem" mode={mode}>
        <textarea
          rows={3}
          value={stem}
          aria-label={plain('review.stem', mode)}
          onChange={(event) => setStem(event.target.value)}
          className={BOX}
        />
      </Field>

      {/* The four options, each with its own "this is the right one" radio.
          A radio and not a dropdown: DESIGN.md wants the answer visible next
          to the text it belongs to. */}
      {OPTION_KEYS.map((labelKey, index) => (
        <div key={labelKey} className="flex items-end gap-2">
          <Field labelKey={labelKey} mode={mode}>
            <input
              type="text"
              value={options[index]}
              aria-label={plain(labelKey, mode)}
              onChange={(event) =>
                setOptions((old) => old.map((one, i) => (i === index ? event.target.value : one)))
              }
              className={BOX}
            />
          </Field>
          <label className="flex min-h-12 min-w-12 items-center justify-center gap-1">
            <input
              type="radio"
              name="correct"
              checked={correctIdx === index}
              aria-label={`${plain('review.correct', mode)} ${OPTION_LETTERS[index]}`}
              onChange={() => setCorrectIdx(index)}
              className="h-5 w-5 accent-primary"
            />
            <span className="text-sm font-medium text-muted-foreground">
              {OPTION_LETTERS[index]}
            </span>
          </label>
        </div>
      ))}

      <Field labelKey="review.explanation" mode={mode}>
        <textarea
          rows={3}
          value={explanation}
          aria-label={plain('review.explanation', mode)}
          onChange={(event) => setExplanation(event.target.value)}
          className={BOX}
        />
      </Field>

      <label className="flex min-h-12 items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          aria-label={plain('review.markChecked', mode)}
          onChange={(event) => setChecked(event.target.checked)}
          className="h-5 w-5 accent-primary"
        />
        <span className="text-base font-medium">{plain('review.markChecked', mode)}</span>
      </label>

      {done ? (
        <p role="status" className="text-muted-foreground">
          {plain('review.saved', mode)}
        </p>
      ) : null}

      <button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
        {plain(busy ? 'review.saving' : 'review.save', mode)}
      </button>
    </form>
  );
}

/** A visible label above the box, plus the same text as the aria-label. */
function Field({
  labelKey,
  mode,
  children,
}: {
  labelKey: MessageKey;
  mode: LangMode;
  children: React.ReactNode;
}) {
  return (
    <label className="flex w-full flex-col gap-1">
      <span className="text-sm font-medium text-muted-foreground">
        {labels(labelKey, mode).map((line, index) => (
          <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
            {line}
          </span>
        ))}
      </span>
      {children}
    </label>
  );
}

function Title({ mode }: { mode: LangMode }) {
  return (
    <h1 className="text-[22px] leading-7 font-bold">
      {labels('review.title', mode).map((line, index) => (
        <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
          {line}
        </span>
      ))}
    </h1>
  );
}
