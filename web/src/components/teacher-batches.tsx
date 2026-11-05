'use client';

/**
 * Teacher Batches: make a batch, then hand over its link (issue 19-batches).
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
 * A fresh batch is added to the list in place, so the teacher sees it land
 * without a page reload on a connection that drops.
 *
 * Nothing here writes `set_access`. Which sets the batch gets free is the
 * batch's own page, and the grant itself is a trigger in `0019_batches.sql`.
 *
 * The `BrowserBatchesClient` is a prop so the test can inject a fake: no real
 * network call and no key in any test (web/CLAUDE.md).
 */
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { createBrowserBatchesClient } from '@/lib/batches/browser-batches-client';
import {
  MAX_BATCH_NAME_LENGTH,
  batchPath,
  joinLink,
  type BatchRow,
  type BrowserBatchesClient,
} from '@/lib/batches/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';

const PRIMARY_BUTTON =
  'min-h-12 w-full rounded-[10px] bg-primary px-3 text-base font-medium text-primary-foreground transition-colors duration-100 disabled:opacity-60';

const BOX =
  'min-h-12 w-full rounded-[10px] border border-border bg-card px-3 text-base text-foreground';

const CARD = 'rounded-[10px] border border-border bg-card p-3';

const QUIET_BUTTON =
  'min-h-12 rounded-[10px] border border-border px-3 text-sm font-medium text-primary';

export function TeacherBatches({
  batches,
  origin,
  client,
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
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const fallback = useMemo(() => createBrowserBatchesClient(), []);
  const data = client ?? fallback;

  const [rows, setRows] = useState<BatchRow[]>(() => [...batches]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);

  if (!configured) {
    return (
      <section className="flex flex-col gap-3">
        <Title mode={mode} />
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

  return (
    <section className="flex flex-col gap-6">
      <form onSubmit={create} className="flex flex-col gap-3" noValidate>
        <Title mode={mode} />
        <p className="text-muted-foreground">{plain('batches.hint', mode)}</p>

        {problem ? (
          <p role="alert" className={`${CARD} text-wrong`}>
            {plain(problem, mode)}
          </p>
        ) : null}

        <label className="flex w-full flex-col gap-1">
          <span className="text-sm font-medium text-muted-foreground">
            {labels('batches.name', mode).map((line, index) => (
              <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
                {line}
              </span>
            ))}
          </span>
          <input
            type="text"
            value={name}
            maxLength={MAX_BATCH_NAME_LENGTH}
            aria-label={plain('batches.name', mode)}
            onChange={(event) => setName(event.target.value)}
            className={BOX}
          />
        </label>

        {done ? (
          <p role="status" className="text-muted-foreground">
            {plain('batches.saved', mode)}
          </p>
        ) : null}

        <button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
          {plain(busy ? 'batches.saving' : 'batches.create', mode)}
        </button>
      </form>

      <BatchList rows={rows} origin={origin} mode={mode} />
    </section>
  );
}

function BatchList({
  rows,
  origin,
  mode,
}: {
  rows: readonly BatchRow[];
  origin: string;
  mode: LangMode;
}) {
  if (rows.length === 0) {
    return (
      <p role="status" className="text-muted-foreground">
        {plain('batches.none', mode)}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <li key={row.id} className={`${CARD} flex flex-col gap-2`}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <span className="font-medium text-foreground">{row.name}</span>
              <span className="text-sm text-muted-foreground">
                {/* Latin digits in both languages (DESIGN.md section 1). */}
                {plain('batches.students', mode)}
                {': '}
                <span className="tabular-nums">{row.studentCount}</span>
              </span>
            </div>

            {/* B3: no viewport prefetch. */}
            <Link href={batchPath(row.id)} prefetch={false} className={`${QUIET_BUTTON} shrink-0 py-3`}>
              {plain('batches.open', mode)}
            </Link>
          </div>

          <CopyLink code={row.joinCode} origin={origin} mode={mode} />
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
    <div className="flex items-center justify-between gap-3">
      <span className="flex flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">{plain('batches.code', mode)}</span>
        {/* Tracking, so a hand-read code does not run together. */}
        <span className="font-mono text-base tracking-widest text-foreground">{code}</span>
      </span>

      <span className="flex shrink-0 items-center gap-2">
        {copied ? (
          <span className="text-xs text-muted-foreground">{plain('batches.copied', mode)}</span>
        ) : null}
        <button type="button" onClick={copy} className={QUIET_BUTTON}>
          {plain('batches.copyLink', mode)}
        </button>
      </span>
    </div>
  );
}

function Title({ mode }: { mode: LangMode }) {
  return (
    <h1 className="text-xl font-semibold text-foreground">
      {labels('batches.title', mode).map((line, index) => (
        <span key={line} className={index === 0 ? 'block' : 'block text-base font-normal'}>
          {line}
        </span>
      ))}
    </h1>
  );
}
