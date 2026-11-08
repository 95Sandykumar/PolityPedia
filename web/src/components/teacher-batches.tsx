'use client';

/**
 * Teacher Batches: make a batch, then hand over its link (issue 19-batches,
 * laid out again in teacher-ui).
 *
 * V2: "teacher creates many batches ... Student joins by link or code." The
 * code is the batch's address, so the one thing this screen must do well is
 * get it out of the phone and into WhatsApp. That is why Copy join link sits
 * on every row and copies the WHOLE link, not the six characters: a student
 * who has to type anything is a student who mistypes it.
 *
 * The code itself is shown beside the button as well, because a teacher
 * reading it out loud in class has no clipboard.
 *
 * LAYOUT. Title and the one primary action on top, then one card per batch
 * (name, student count, Open, and the code with its copy button), with the
 * create form in its own card beside the list on a laptop and under it on a
 * phone.
 *
 * A fresh batch is added to the list in place, so the teacher sees it land
 * without a page reload on a connection that drops.
 *
 * Nothing here writes `set_access`. Which sets the batch gets free is the
 * batch's own page, and the grant itself is a trigger in `0019_batches.sql`.
 *
 * The `BrowserBatchesClient` is a prop so the test can inject a fake: no real
 * network call and no key in any test (web/CLAUDE.md).
 */
import { Check, ChevronRight, Copy, Plus, Users } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  ArchiveNotice,
  ArchiveTabs,
  RemoveButton,
  RestoreButton,
  useArchiveList,
  type ArchiveList,
} from '@/components/archive-controls';
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
  goToForm,
} from '@/components/teacher-ui';
import type { BrowserArchiveClient } from '@/lib/archive/types';
import { createBrowserBatchesClient } from '@/lib/batches/browser-batches-client';
import {
  MAX_BATCH_NAME_LENGTH,
  batchPath,
  joinLink,
  type BatchRow,
  type BrowserBatchesClient,
} from '@/lib/batches/types';
import { DEFAULT_MODE, plain, type LangMode, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const FORM_ID = 'batch-form';

export function TeacherBatches({
  batches,
  origin,
  client,
  archiveClient,
  mode = DEFAULT_MODE,
  configured = true,
}: {
  /** The teacher's own batches, newest first, with their student counts. */
  batches: readonly BatchRow[];
  /**
   * Where this app is served from, for the copied link. Empty on the server's
   * first paint, which gives a relative link rather than "undefined/join/...".
   */
  origin: string;
  client?: BrowserBatchesClient;
  /** Delete, archive and restore (issue 45). A prop so tests can fake it. */
  archiveClient?: BrowserArchiveClient;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const fallback = useMemo(() => createBrowserBatchesClient(), []);
  const data = client ?? fallback;

  const archive = useArchiveList<BatchRow>(
    batches,
    'batch',
    'archive.archivedBatch',
    archiveClient,
  );
  const { rows, setRows } = archive;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);

  if (!configured) {
    return (
      <section className="flex flex-col gap-4">
        <PageHeader titleKey="batches.title" mode={mode} icon={Users} />
        <p role="status" className="text-muted-foreground">
          {plain('batches.notConfigured', mode)}
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
    const clean = name.trim();
    if (clean.length === 0) {
      setProblem('batches.needName');
      return;
    }

    setBusy(true);
    try {
      const made = await data.saveBatch({ id: null, name: clean });
      // Newest row in place, so the teacher sees it land with no reload. A
      // fresh batch has nobody in it yet.
      setRows((current) => [{ ...made, studentCount: 0 }, ...current]);
      setDone(true);
      setName('');
    } catch {
      // One line of ours. Never a server message.
      setProblem('batches.failed');
    } finally {
      setBusy(false);
    }
  }

  const newBatch = (
    <button type="button" onClick={() => goToForm(FORM_ID)} className={PRIMARY_BUTTON}>
      <Plus size={20} strokeWidth={2} aria-hidden="true" />
      {plain('teacherUi.newBatch', mode)}
    </button>
  );

  return (
    <section className="flex flex-col gap-6">
      <PageHeader titleKey="batches.title" mode={mode} icon={Users} action={newBatch} />

      <ListLayout
        list={
          <BatchList
            rows={archive.visible}
            archive={archive}
            origin={origin}
            mode={mode}
            empty={
              <EmptyState
                icon={Users}
                text={plain('batches.none', mode)}
                action={
                  <button
                    type="button"
                    onClick={() => goToForm(FORM_ID)}
                    className={cn(QUIET_BUTTON, 'lg:hidden')}
                  >
                    <Plus size={20} strokeWidth={2} aria-hidden="true" />
                    {plain('teacherUi.newBatch', mode)}
                  </button>
                }
              />
            }
          />
        }
        form={
          <FormPanel id={FORM_ID} titleKey="teacherUi.newBatch" mode={mode} icon={Plus}>
            <form onSubmit={create} className="flex flex-col gap-3" noValidate>
              <p className="text-sm text-muted-foreground">{plain('batches.hint', mode)}</p>

              {problem ? (
                <p
                  role="alert"
                  className="rounded-[10px] border border-wrong bg-wrong-soft p-3 text-wrong"
                >
                  {plain(problem, mode)}
                </p>
              ) : null}

              <Field labelKey="batches.name" mode={mode}>
                <input
                  type="text"
                  value={name}
                  maxLength={MAX_BATCH_NAME_LENGTH}
                  aria-label={plain('batches.name', mode)}
                  onChange={(event) => setName(event.target.value)}
                  className={BOX}
                />
              </Field>

              {done ? (
                <p role="status" className="text-sm font-medium text-primary">
                  {plain('batches.saved', mode)}
                </p>
              ) : null}

              <button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
                {plain(busy ? 'batches.saving' : 'batches.create', mode)}
              </button>
            </form>
          </FormPanel>
        }
      />
    </section>
  );
}

function BatchList({
  rows,
  archive,
  origin,
  mode,
  empty,
}: {
  rows: readonly BatchRow[];
  archive: ArchiveList<BatchRow>;
  origin: string;
  mode: LangMode;
  empty: React.ReactNode;
}) {
  const archived = archive.tab === 'archived';

  return (
    <div className="flex flex-col gap-3">
      <ArchiveNotice list={archive} mode={mode} />
      <ArchiveTabs list={archive} mode={mode} />
      {rows.length === 0 ? (
        archived ? (
          <p role="status" className="text-muted-foreground">
            {plain('archive.none', mode)}
          </p>
        ) : (
          <>{empty}</>
        )
      ) : (
        <BatchRows rows={rows} archive={archive} origin={origin} mode={mode} />
      )}
    </div>
  );
}

function BatchRows({
  rows,
  archive,
  origin,
  mode,
}: {
  rows: readonly BatchRow[];
  archive: ArchiveList<BatchRow>;
  origin: string;
  mode: LangMode;
}) {
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <li key={row.id} className={cn(CARD, 'flex flex-col gap-3')}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="font-medium break-words text-foreground">{row.name}</span>
              <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                <Users size={16} strokeWidth={2} aria-hidden="true" />
                <span>
                  {/* Latin digits in both languages (DESIGN.md section 1). */}
                  {plain('batches.students', mode)}
                  {': '}
                  <span className="font-bold text-foreground tabular-nums">{row.studentCount}</span>
                </span>
              </span>
            </div>

            {/* B3: no viewport prefetch. */}
            <Link
              href={batchPath(row.id)}
              prefetch={false}
              className={cn(QUIET_BUTTON, 'shrink-0 border-primary text-primary')}
            >
              {plain('batches.open', mode)}
              <ChevronRight size={20} strokeWidth={2} aria-hidden="true" />
            </Link>
          </div>

          {row.archivedAt ? (
            // An archived batch cannot be joined, so its code has no use.
            <div className="flex justify-end">
              <RestoreButton list={archive} id={row.id} mode={mode} />
            </div>
          ) : (
            <>
              <CopyLink code={row.joinCode} origin={origin} mode={mode} />
              <div className="flex justify-end">
                <RemoveButton list={archive} id={row.id} mode={mode} />
              </div>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The code, readable, next to a button that copies the whole link.
 *
 * `navigator.clipboard` is missing on an old Android browser and on the
 * server, so the call is guarded: the teacher still sees the code and can read
 * it out, which is the fallback that needs no API at all.
 */
function CopyLink({
  code,
  origin,
  mode,
}: {
  code: string;
  origin: string;
  mode: LangMode;
}) {
  const [copied, setCopied] = useState(false);
  const link = joinLink(origin, code);

  async function copy() {
    try {
      await navigator.clipboard?.writeText(link);
      setCopied(true);
    } catch {
      // No clipboard. The code is on screen either way, so there is nothing
      // to tell the teacher that they cannot already see.
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] bg-background p-3">
      <span className="flex flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">{plain('batches.code', mode)}</span>
        {/* Tracking, so a hand-read code does not run together. */}
        <span className="font-mono text-lg leading-6 font-bold tracking-widest text-foreground">
          {code}
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-2">
        {copied ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
            <Check size={14} strokeWidth={2} aria-hidden="true" />
            {plain('batches.copied', mode)}
          </span>
        ) : null}
        <button type="button" onClick={copy} className={cn(QUIET_BUTTON, 'text-primary')}>
          <Copy size={20} strokeWidth={2} aria-hidden="true" />
          {plain('batches.copyLink', mode)}
        </button>
      </span>
    </div>
  );
}
