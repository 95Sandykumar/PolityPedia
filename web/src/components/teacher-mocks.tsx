'use client';

/**
 * Teacher Mock sets: create a set, price it, then open it to add tests
 * (issue 15-mock-sets-authoring, laid out again in teacher-ui).
 *
 * V10 and V11: a set belongs to one exam and one teacher, and the teacher
 * picks the price between Rs 299 and Rs 399. The earning line next to the
 * stepper is the reason the stepper exists: a teacher moving the price should
 * see what the move does to their own pocket, before they commit to it.
 *
 * LAYOUT. Title and the one primary action on top, the teacher's sets as
 * rows (name, exam, price, Live or Draft, Open), and the create form in its
 * own card: beside the list on a laptop, under it on a phone.
 *
 * Native `<select>` on purpose: a cheap Android phone then shows its own wheel,
 * which beats anything we could ship on 4G (DESIGN.md section 10).
 *
 * A fresh set is added to the list in place, so the teacher sees it land
 * without a page reload on a connection that drops.
 *
 * Nothing goes live here: the row is a DRAFT and the chip says so. Publish
 * lives on the set's own page, behind `publish_mock_set()`.
 *
 * The `BrowserMockSetsClient` is a prop so the test can inject a fake: no real
 * network call and no key in any test (web/CLAUDE.md).
 */
import { ChevronRight, ListChecks, Plus } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { PriceStepper } from '@/components/price-stepper';
import {
  BOX,
  CARD,
  EmptyState,
  Field,
  FormPanel,
  ListLayout,
  PageHeader,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  StatusChip,
  goToForm,
} from '@/components/teacher-ui';
import { examLabels, type Exam } from '@/lib/exams/types';
import { createBrowserMocksClient } from '@/lib/mocks/browser-mocks-client';
import {
  MAX_SET_TITLE_LENGTH,
  MIN_PRICE_INR,
  mockSetPath,
  type BrowserMockSetsClient,
  type MockSet,
} from '@/lib/mocks/types';
import { DEFAULT_MODE, plain, type LangMode, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** The code the client throws -> the one line the teacher reads. */
const PROBLEM_LABELS: Record<string, MessageKey> = {
  duplicate: 'mocks.duplicate',
};

const FORM_ID = 'mock-form';

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
      <section className="flex flex-col gap-4">
        <PageHeader titleKey="mocks.title" mode={mode} icon={ListChecks} />
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

  const newSet = (
    <button type="button" onClick={() => goToForm(FORM_ID)} className={PRIMARY_BUTTON}>
      <Plus size={20} strokeWidth={2} aria-hidden="true" />
      {plain('teacherUi.newMock', mode)}
    </button>
  );

  return (
    <section className="flex flex-col gap-6">
      <PageHeader titleKey="mocks.title" mode={mode} icon={ListChecks} action={newSet} />

      <ListLayout
        list={
          <MockSetList
            sets={rows}
            exams={exams}
            mode={mode}
            empty={
              <EmptyState
                icon={ListChecks}
                text={plain('mocks.none', mode)}
                action={
                  <button
                    type="button"
                    onClick={() => goToForm(FORM_ID)}
                    className={cn(QUIET_BUTTON, 'lg:hidden')}
                  >
                    <Plus size={20} strokeWidth={2} aria-hidden="true" />
                    {plain('teacherUi.newMock', mode)}
                  </button>
                }
              />
            }
          />
        }
        form={
          <FormPanel id={FORM_ID} titleKey="teacherUi.newMock" mode={mode} icon={Plus}>
            <form onSubmit={create} className="flex flex-col gap-3" noValidate>
              <p className="text-sm text-muted-foreground">{plain('mocks.hint', mode)}</p>

              {problem ? (
                <p
                  role="alert"
                  className="rounded-[10px] border border-wrong bg-wrong-soft p-3 text-wrong"
                >
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
                <p role="status" className="text-sm font-medium text-primary">
                  {plain('mocks.saved', mode)}
                </p>
              ) : null}

              <button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
                {plain(busy ? 'mocks.saving' : 'mocks.create', mode)}
              </button>
            </form>
          </FormPanel>
        }
      />
    </section>
  );
}

/** The teacher's own sets, newest first, each a door into its own page. */
function MockSetList({
  sets,
  exams,
  mode,
  empty,
}: {
  sets: readonly MockSet[];
  exams: readonly Exam[];
  mode: LangMode;
  empty: React.ReactNode;
}) {
  if (sets.length === 0) return <>{empty}</>;

  return (
    <ul className="flex flex-col gap-3">
      {sets.map((set) => {
        const exam = exams.find((one) => one.id === set.examId);
        return (
          <li key={set.id} className={cn(CARD, 'flex items-center justify-between gap-3')}>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="font-medium break-words text-foreground">{set.title}</span>
              <span className="text-sm text-muted-foreground">
                {/* An exam missing from the catalogue leaves the line without
                    a name rather than hiding the set the teacher just made. */}
                {exam ? examLabels(exam, mode).join(' / ') : ''}
              </span>
              <span className="flex flex-wrap items-center gap-2">
                {/* Latin digits with the rupee sign in both languages
                    (DESIGN.md section 1). */}
                <span className="font-bold tabular-nums">{'₹' + set.priceInr}</span>
                <StatusChip live={set.status === 'live'}>
                  {plain(set.status === 'live' ? 'mocks.live' : 'mocks.draft', mode)}
                </StatusChip>
              </span>
            </div>

            {/* B3: no viewport prefetch. */}
            <Link
              href={mockSetPath(set.id)}
              prefetch={false}
              className={cn(QUIET_BUTTON, 'shrink-0 border-primary text-primary')}
            >
              {plain('mocks.open', mode)}
              <ChevronRight size={20} strokeWidth={2} aria-hidden="true" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
