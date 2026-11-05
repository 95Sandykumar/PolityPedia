'use client';

/**
 * Teacher Mock sets: create a set, price it, then open it to add tests
 * (issue 15-mock-sets-authoring).
 *
 * V10 and V11: a set belongs to one exam and one teacher, and the teacher
 * picks the price between Rs 299 and Rs 399. The earning line next to the
 * stepper is the reason the stepper exists: a teacher moving the price should
 * see what the move does to their own pocket, before they commit to it.
 *
 * Native `<select>` on purpose: a cheap Android phone then shows its own wheel,
 * which beats anything we could ship on 4G (DESIGN.md section 10).
 *
 * A fresh set is added to the list in place, so the teacher sees it land
 * without a page reload on a connection that drops.
 *
 * Nothing goes live here: the row is a DRAFT and the badge says so. Publish
 * lives on the set's own page, behind `publish_mock_set()`.
 *
 * The `BrowserMockSetsClient` is a prop so the test can inject a fake: no real
 * network call and no key in any test (web/CLAUDE.md).
 */
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { PriceStepper } from '@/components/price-stepper';
import { examLabels, type Exam } from '@/lib/exams/types';
import { createBrowserMocksClient } from '@/lib/mocks/browser-mocks-client';
import {
  MAX_SET_TITLE_LENGTH,
  MIN_PRICE_INR,
  mockSetPath,
  type BrowserMockSetsClient,
  type MockSet,
} from '@/lib/mocks/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';

const PRIMARY_BUTTON =
  'min-h-12 w-full rounded-[10px] bg-primary px-3 text-base font-medium text-primary-foreground transition-colors duration-100 disabled:opacity-60';

const BOX =
  'min-h-12 w-full rounded-[10px] border border-border bg-card px-3 text-base text-foreground';

const CARD = 'rounded-[10px] border border-border bg-card p-3';

const BADGE = 'rounded-full border border-border px-2 py-0.5 text-xs font-medium';

/** The code the client throws -> the one line the teacher reads. */
const PROBLEM_LABELS: Record<string, MessageKey> = {
  duplicate: 'mocks.duplicate',
};

export function TeacherMocks({
  exams,
  sets,
  sharePct,
  client,
  mode = DEFAULT_MODE,
  configured = true,
}: {
  /** The catalogue. The teacher picks the exam the set is for. */
  exams: readonly Exam[];
  /** The teacher's own sets, drafts included. */
  sets: readonly MockSet[];
  /** The teacher's own `revenue_share_pct` (X3). */
  sharePct: number;
  client?: BrowserMockSetsClient;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const fallback = useMemo(() => createBrowserMocksClient(), []);
  const data = client ?? fallback;

  const [rows, setRows] = useState<MockSet[]>(() => [...sets]);
  const [examId, setExamId] = useState(exams[0]?.id ?? '');
  const [title, setTitle] = useState('');
  // The floor, so a teacher who never touches the stepper sells at the
  // cheapest price rather than at the most expensive one.
  const [price, setPrice] = useState(MIN_PRICE_INR);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);

  if (!configured) {
    return (
      <section className="flex flex-col gap-3">
        <Title mode={mode} />
        <p role="status" className="text-muted-foreground">
          {plain('mocks.notConfigured', mode)}
        </p>
      </section>
    );
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setDone(false);
    setProblem(null);

    // Asked here as well as in the route, so a teacher who left the name
    // blank gets the line with no request at all.
    const clean = title.trim();
    if (clean.length === 0) {
      setProblem('mocks.needName');
      return;
    }

    setBusy(true);
    try {
      const made = await data.saveSet({ id: null, examId, title: clean, priceInr: price });

      // Newest row in place, so the teacher sees it land with no reload.
      setRows((current) => [made, ...current]);
      setDone(true);
      setTitle('');
    } catch (cause) {
      // Our own short code, or the generic line. Never a server message.
      const code = (cause as Error)?.message ?? '';
      setProblem(PROBLEM_LABELS[code] ?? 'mocks.failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <form onSubmit={create} className="flex flex-col gap-3" noValidate>
        <Title mode={mode} />
        <p className="text-muted-foreground">{plain('mocks.hint', mode)}</p>

        {problem ? (
          <p role="alert" className={`${CARD} text-wrong`}>
            {plain(problem, mode)}
          </p>
        ) : null}

        <Field labelKey="mocks.exam" mode={mode}>
          <select
            value={examId}
            aria-label={plain('mocks.exam', mode)}
            onChange={(event) => setExamId(event.target.value)}
            className={BOX}
          >
            {exams.map((exam) => (
              <option key={exam.id} value={exam.id}>
                {examLabels(exam, mode).join(' / ')}
              </option>
            ))}
          </select>
        </Field>

        <Field labelKey="mocks.name" mode={mode}>
          <input
            type="text"
            value={title}
            maxLength={MAX_SET_TITLE_LENGTH}
            aria-label={plain('mocks.name', mode)}
            onChange={(event) => setTitle(event.target.value)}
            className={BOX}
          />
        </Field>

        <PriceStepper
          price={price}
          onChange={setPrice}
          sharePct={sharePct}
          mode={mode}
          busy={busy}
        />

        {done ? (
          <p role="status" className="text-muted-foreground">
            {plain('mocks.saved', mode)}
          </p>
        ) : null}

        <button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
          {plain(busy ? 'mocks.saving' : 'mocks.create', mode)}
        </button>
      </form>

      <MockSetList sets={rows} exams={exams} mode={mode} />
    </section>
  );
}

/** The teacher's own sets, newest first, each a door into its own page. */
function MockSetList({
  sets,
  exams,
  mode,
}: {
  sets: readonly MockSet[];
  exams: readonly Exam[];
  mode: LangMode;
}) {
  if (sets.length === 0) {
    return (
      <p role="status" className="text-muted-foreground">
        {plain('mocks.none', mode)}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {sets.map((set) => {
        const exam = exams.find((one) => one.id === set.examId);
        return (
          <li key={set.id} className={`${CARD} flex items-center justify-between gap-3`}>
            <div className="flex flex-col gap-1">
              <span className="font-medium text-foreground">{set.title}</span>
              <span className="text-sm text-muted-foreground">
                {/* An exam missing from the catalogue leaves the line without
                    a name rather than hiding the set the teacher just made. */}
                {exam ? examLabels(exam, mode).join(' / ') : ''}
              </span>
              <span className="flex items-center gap-2">
                {/* Latin digits with the rupee sign in both languages
                    (DESIGN.md section 1). */}
                <span className="tabular-nums font-medium">{'₹' + set.priceInr}</span>
                <span className={BADGE}>
                  {plain(set.status === 'live' ? 'mocks.live' : 'mocks.draft', mode)}
                </span>
              </span>
            </div>

            {/* B3: no viewport prefetch. */}
            <Link
              href={mockSetPath(set.id)}
              prefetch={false}
              className="min-h-12 shrink-0 rounded-[10px] border border-border px-3 py-3 text-sm font-medium text-primary"
            >
              {plain('mocks.open', mode)}
            </Link>
          </li>
        );
      })}
    </ul>
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
      {labels('mocks.title', mode).map((line, index) => (
        <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
          {line}
        </span>
      ))}
    </h1>
  );
}
