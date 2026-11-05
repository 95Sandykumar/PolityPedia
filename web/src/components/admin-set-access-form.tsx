'use client';

/**
 * Admin screen: open a mock set for one student, or close it again
 * (issue 16-set-access-mock-list).
 *
 * This is the "admin page to grant a set to a student (source admin)" in the
 * vertical slice: the way a set is opened before Razorpay exists (issues 26
 * and 27), and the way support opens one afterwards.
 *
 * The client is a prop so the test can inject a fake: no real network call and
 * no real key in any test (web/CLAUDE.md).
 *
 * Security: the real gate is the `set_access_admin_all` RLS policy inside
 * Postgres. This form is convenience, not permission, and it shows one fixed
 * failure message so a policy name never reaches the page.
 */
import { useMemo, useState } from 'react';
import { createBrowserSetAccessClient } from '@/lib/set-access/browser-set-access-client';
import type { AdminSetAccessClient } from '@/lib/set-access/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

/** DESIGN.md: 48 px touch target, radius 10, 1 px border, tokens only. */
const FIELD =
  'min-h-12 w-full rounded-[10px] border border-border bg-card px-3 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';
const PRIMARY_BUTTON =
  'min-h-12 w-full rounded-[10px] bg-primary px-3 text-base font-medium text-white transition-colors duration-100 disabled:opacity-60';
const OUTLINE_BUTTON =
  'min-h-12 w-full rounded-[10px] border border-border bg-card px-3 text-base font-medium text-foreground transition-colors duration-100 disabled:opacity-60';

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

/** Clamp to 1..365 days. A typo must not hand out a ten-year grant. */
function readDays(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(1, parsed));
}

export function AdminSetAccessForm({
  client,
  mode = DEFAULT_MODE,
  configured = true,
}: {
  client?: AdminSetAccessClient;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const fallback = useMemo(() => createBrowserSetAccessClient(), []);
  const access = client ?? fallback;

  const [userId, setUserId] = useState('');
  const [setId, setSetId] = useState('');
  const [days, setDays] = useState(String(DEFAULT_DAYS));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'granted' | 'revoked' | null>(null);
  const [failed, setFailed] = useState(false);

  const title = (
    <h1 className="text-[22px] leading-7 font-bold">
      <Lines keyName="setAccess.title" mode={mode} />
    </h1>
  );

  if (!configured) {
    return (
      <section className="flex flex-col gap-3">
        {title}
        <p role="status" className="text-muted-foreground">
          {plain('setAccess.notConfigured', mode)}
        </p>
      </section>
    );
  }

  async function run(action: 'grant' | 'revoke') {
    const student = userId.trim();
    const set = setId.trim();
    if (!student || !set || busy) return;
    setBusy(true);
    setFailed(false);
    setDone(null);
    try {
      if (action === 'grant') {
        const validUntil = new Date(Date.now() + readDays(days) * DAY_MS).toISOString();
        await access.grant({ userId: student, setId: set, validUntil });
        setDone('granted');
      } else {
        await access.revoke({ userId: student, setId: set });
        setDone('revoked');
      }
    } catch {
      // Fixed message only: the thrown error may quote Postgres.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      {title}
      <p className="text-sm text-muted-foreground">{plain('setAccess.hint', mode)}</p>

      {failed ? (
        <p role="alert" className="rounded-[10px] border border-border bg-card p-3 text-wrong">
          {plain('setAccess.failed', mode)}
        </p>
      ) : null}

      {done ? (
        <p role="status" className="rounded-[10px] border border-border bg-card p-3 text-correct">
          {plain(done === 'granted' ? 'setAccess.granted' : 'setAccess.revoked', mode)}
        </p>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run('grant');
        }}
        className="flex flex-col gap-3"
        noValidate
      >
        <label htmlFor="set-access-user-id" className="text-sm font-medium">
          <Lines keyName="setAccess.userId" mode={mode} />
        </label>
        <input
          id="set-access-user-id"
          name="userId"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
          className={FIELD + ' font-mono text-sm'}
        />

        <label htmlFor="set-access-set-id" className="text-sm font-medium">
          <Lines keyName="setAccess.setId" mode={mode} />
        </label>
        <input
          id="set-access-set-id"
          name="setId"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={setId}
          onChange={(event) => setSetId(event.target.value)}
          className={FIELD + ' font-mono text-sm'}
        />

        <label htmlFor="set-access-days" className="text-sm font-medium">
          <Lines keyName="setAccess.days" mode={mode} />
        </label>
        <input
          id="set-access-days"
          name="days"
          type="number"
          min={1}
          max={MAX_DAYS}
          inputMode="numeric"
          value={days}
          onChange={(event) => setDays(event.target.value)}
          className={FIELD + ' tabular-nums'}
        />

        <button
          type="submit"
          disabled={busy}
          aria-label={plain('setAccess.grant', mode)}
          className={PRIMARY_BUTTON}
        >
          {plain(busy ? 'setAccess.saving' : 'setAccess.grant', mode)}
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => void run('revoke')}
          aria-label={plain('setAccess.revoke', mode)}
          className={OUTLINE_BUTTON}
        >
          {plain('setAccess.revoke', mode)}
        </button>
      </form>
    </section>
  );
}
