'use client';

/**
 * Delete, archive and restore for the teacher lists
 * (issue 45-keep-money-and-scores).
 *
 * One hook and four small pieces, shared by the mock set list, the test rows
 * in the set editor, the papers list and the batches list, so the four screens
 * say and do the same thing:
 *
 *  * Delete asks once ("Delete this?" Yes / Cancel), because it may be real.
 *  * The reply decides the toast. `deleted` -> "Deleted." `archived` -> "Archived.
 *    Students who paid keep access. Restore within 30 days." Postgres decides
 *    which; the screen only reports it.
 *  * Archived rows leave the main list and live under an "Archived" tab, each
 *    with a Restore button.
 *
 * The browser client is a prop on every screen, so the tests inject a fake: no
 * real network call and no key in any test (web/CLAUDE.md).
 */
import { ArchiveRestore, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { QUIET_BUTTON } from '@/components/teacher-ui';
import { createBrowserArchiveClient } from '@/lib/archive/browser-archive-client';
import type { ArchiveKind, BrowserArchiveClient } from '@/lib/archive/types';
import { plain, type LangMode, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export interface Archivable {
  id: string;
  archivedAt?: string | null;
}

export type ArchiveTab = 'active' | 'archived';

interface Notice {
  key: MessageKey;
  bad: boolean;
}

/** The code the browser client throws -> the one line the teacher reads. */
const ERROR_LINES: Record<string, MessageKey> = {
  'not-found': 'archive.notFound',
  'window-over': 'archive.windowOver',
};

export interface ArchiveList<T extends Archivable> {
  rows: T[];
  setRows: React.Dispatch<React.SetStateAction<T[]>>;
  /** Rows to show for the current tab. */
  visible: T[];
  archivedCount: number;
  tab: ArchiveTab;
  setTab: (tab: ArchiveTab) => void;
  notice: Notice | null;
  /** The id that is waiting for "Yes, delete", or null. */
  confirming: string | null;
  setConfirming: (id: string | null) => void;
  /** The id whose request is in flight, or null. */
  busy: string | null;
  remove: (id: string) => Promise<void>;
  restore: (id: string) => Promise<void>;
}

/**
 * State for one archive-aware list.
 *
 * `archivedKey` is the toast shown when the answer is `archived`, because the
 * words differ: a set keeps its buyers, a paper keeps its results, a batch
 * keeps its reports.
 */
export function useArchiveList<T extends Archivable>(
  initial: readonly T[],
  kind: ArchiveKind,
  archivedKey: MessageKey,
  client?: BrowserArchiveClient,
): ArchiveList<T> {
  const fallback = useMemo(() => createBrowserArchiveClient(), []);
  const data = client ?? fallback;

  const [rows, setRows] = useState<T[]>(() => [...initial]);
  const [tab, setTab] = useState<ArchiveTab>('active');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  function fail(cause: unknown) {
    const code = (cause as Error)?.message ?? '';
    setNotice({ key: ERROR_LINES[code] ?? 'archive.failed', bad: true });
  }

  async function remove(id: string) {
    if (busy) return;
    setBusy(id);
    setNotice(null);
    try {
      const result = await data.remove(kind, id);
      if (result === 'deleted') {
        setRows((current) => current.filter((one) => one.id !== id));
        setNotice({ key: 'archive.deleted', bad: false });
      } else {
        // The date is only a marker for the screen. The real one is Postgres's.
        const now = new Date().toISOString();
        setRows((current) =>
          current.map((one) => (one.id === id ? { ...one, archivedAt: now } : one)),
        );
        setNotice({ key: archivedKey, bad: false });
      }
    } catch (cause) {
      fail(cause);
    } finally {
      setConfirming(null);
      setBusy(null);
    }
  }

  async function restore(id: string) {
    if (busy) return;
    setBusy(id);
    setNotice(null);
    try {
      await data.restore(kind, id);
      setRows((current) =>
        current.map((one) => (one.id === id ? { ...one, archivedAt: null } : one)),
      );
      setNotice({ key: 'archive.restored', bad: false });
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(null);
    }
  }

  const archivedCount = rows.filter((one) => one.archivedAt).length;
  const visible = rows.filter((one) => (tab === 'archived' ? one.archivedAt : !one.archivedAt));

  return {
    rows,
    setRows,
    visible,
    archivedCount,
    tab,
    setTab,
    notice,
    confirming,
    setConfirming,
    busy,
    remove,
    restore,
  };
}

/** Active / Archived. Hidden until something has been archived. */
export function ArchiveTabs<T extends Archivable>({
  list,
  mode,
}: {
  list: ArchiveList<T>;
  mode: LangMode;
}) {
  if (list.archivedCount === 0 && list.tab === 'active') return null;

  const tabs: { id: ArchiveTab; key: MessageKey }[] = [
    { id: 'active', key: 'archive.tabActive' },
    { id: 'archived', key: 'archive.tabArchived' },
  ];

  return (
    <div role="group" aria-label={plain('archive.tabArchived', mode)} className="flex gap-2">
      {tabs.map((one) => (
        <button
          key={one.id}
          type="button"
          aria-pressed={list.tab === one.id}
          onClick={() => list.setTab(one.id)}
          className={cn(
            'inline-flex min-h-12 items-center justify-center gap-2 rounded-[10px] border px-4 text-base font-medium transition-colors duration-100',
            list.tab === one.id
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border bg-card text-foreground hover:bg-background',
          )}
        >
          {plain(one.key, mode)}
          {one.id === 'archived' ? (
            <span className="tabular-nums">{list.archivedCount}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** The toast: what just happened, in one line. */
export function ArchiveNotice<T extends Archivable>({
  list,
  mode,
}: {
  list: ArchiveList<T>;
  mode: LangMode;
}) {
  if (!list.notice) return null;
  return list.notice.bad ? (
    <p role="alert" className="rounded-[10px] border border-wrong bg-wrong-soft p-3 text-wrong">
      {plain(list.notice.key, mode)}
    </p>
  ) : (
    <p role="status" className="rounded-[10px] bg-primary/10 p-3 font-medium text-primary">
      {plain(list.notice.key, mode)}
    </p>
  );
}

/** Delete, with one confirm step. For a row in the Active tab. */
export function RemoveButton<T extends Archivable>({
  list,
  id,
  mode,
}: {
  list: ArchiveList<T>;
  id: string;
  mode: LangMode;
}) {
  const working = list.busy === id;

  if (list.confirming === id) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">{plain('archive.confirmAsk', mode)}</span>
        <button
          type="button"
          disabled={working}
          onClick={() => void list.remove(id)}
          className={cn(QUIET_BUTTON, 'border-wrong text-wrong')}
        >
          {plain(working ? 'archive.working' : 'archive.confirmYes', mode)}
        </button>
        <button
          type="button"
          disabled={working}
          onClick={() => list.setConfirming(null)}
          className={QUIET_BUTTON}
        >
          {plain('archive.cancel', mode)}
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={list.busy !== null}
      onClick={() => list.setConfirming(id)}
      className={cn(QUIET_BUTTON, 'text-wrong')}
    >
      <Trash2 size={20} strokeWidth={2} aria-hidden="true" />
      {plain('archive.delete', mode)}
    </button>
  );
}

/** Restore, for a row in the Archived tab. */
export function RestoreButton<T extends Archivable>({
  list,
  id,
  mode,
}: {
  list: ArchiveList<T>;
  id: string;
  mode: LangMode;
}) {
  return (
    <button
      type="button"
      disabled={list.busy !== null}
      onClick={() => void list.restore(id)}
      className={cn(QUIET_BUTTON, 'border-primary text-primary')}
    >
      <ArchiveRestore size={20} strokeWidth={2} aria-hidden="true" />
      {plain(list.busy === id ? 'archive.working' : 'archive.restore', mode)}
    </button>
  );
}
