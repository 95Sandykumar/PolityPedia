'use client';

/**
 * Admin screen: open a mock set for one student, or close it again
 * (issue 16-set-access-mock-list, laid out again in the admin-ui pass).
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
 *
 * Source: hand-built from DESIGN.md tokens (grouped fieldsets, hint + error
 * under each field, Lucide icons).
 */
import { useId, useMemo, useRef, useState } from 'react';
import { Ban, LockOpen } from 'lucide-react';
import { createBrowserSetAccessClient } from '@/lib/set-access/browser-set-access-client';
import type { AdminSetAccessClient } from '@/lib/set-access/types';
import { DEFAULT_MODE, plain, type LangMode } from '@/lib/i18n';
import {
  Banner,
  CARD,
  FIELD,
  Lines,
  OUTLINE_BUTTON,
  PageHeader,
  PRIMARY_BUTTON,
  utcDay,
} from '@/components/admin-ui';
import { useMounted } from '@/components/use-mounted';

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

/** Clamp to 1..365 days. A typo must not hand out a ten-year grant. */
function readDays(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(1, parsed));
}

/** True when what was typed is not already a whole number in 1..365. */
function daysWereFixed(value: string): boolean {
  const parsed = Number.parseInt(value, 10);
  return (
    !Number.isFinite(parsed) || parsed < 1 || parsed > MAX_DAYS || String(parsed) !== value.trim()
  );
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
  /** Set when a press found a required field empty, so the message can show. */
  const [attempted, setAttempted] = useState(false);
  const userRef = useRef<HTMLInputElement>(null);
  const setRef = useRef<HTMLInputElement>(null);
  const mounted = useMounted();
  const ids = useId();

  const title = <Lines keyName="setAccess.title" mode={mode} />;

  if (!configured) {
    return (
      <section className="flex flex-col gap-4">
        <PageHeader title={title} />
        <Banner tone="info" role="status">
          {plain('setAccess.notConfigured', mode)}
        </Banner>
      </section>
    );
  }

  async function run(action: 'grant' | 'revoke') {
    const student = userId.trim();
    const set = setId.trim();
    if (!student || !set) {
      setAttempted(true);
      (student ? setRef : userRef).current?.focus();
      return;
    }
    if (busy) return;
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

  const userMissing = attempted && userId.trim() === '';
  const setMissing = attempted && setId.trim() === '';
  const userHint = ids + '-user-hint';
  const userError = ids + '-user-error';
  const setHint = ids + '-set-hint';
  const setError = ids + '-set-error';
  const daysHint = ids + '-days-hint';

  return (
    <section className="flex flex-col gap-4">
      <PageHeader title={title} hint={plain('setAccess.hint', mode)} />

      {failed ? (
        <Banner tone="error" role="alert">
          {plain('setAccess.failed', mode)}
        </Banner>
      ) : null}

      {done ? (
        <Banner tone="success" role="status">
          {plain(done === 'granted' ? 'setAccess.granted' : 'setAccess.revoked', mode)}
        </Banner>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run('grant');
        }}
        className={CARD + ' flex w-full max-w-[640px] flex-col gap-6 p-4'}
        noValidate
      >
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="mb-3 p-0 text-lg leading-6 font-bold">
            {plain('adminForm.groupStudent', mode)}
          </legend>
          <div className="flex flex-col gap-1">
            <label htmlFor="set-access-user-id" className="text-sm font-medium">
              <Lines keyName="setAccess.userId" mode={mode} />
            </label>
            <input
              ref={userRef}
              id="set-access-user-id"
              name="userId"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              aria-invalid={userMissing || undefined}
              aria-describedby={userMissing ? userError + ' ' + userHint : userHint}
              className={FIELD + ' font-mono text-sm' + (userMissing ? ' border-wrong-icon' : '')}
            />
            <p id={userHint} className="text-sm text-muted-foreground">
              {plain('adminForm.userIdHint', mode)}
            </p>
            {userMissing ? (
              <p id={userError} className="text-sm font-medium text-wrong">
                {plain('adminForm.needUser', mode)}
              </p>
            ) : null}
          </div>
        </fieldset>

        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="mb-3 p-0 text-lg leading-6 font-bold">
            {plain('adminForm.groupSet', mode)}
          </legend>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="set-access-set-id" className="text-sm font-medium">
                <Lines keyName="setAccess.setId" mode={mode} />
              </label>
              <input
                ref={setRef}
                id="set-access-set-id"
                name="setId"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={setId}
                onChange={(event) => setSetId(event.target.value)}
                aria-invalid={setMissing || undefined}
                aria-describedby={setMissing ? setError + ' ' + setHint : setHint}
                className={FIELD + ' font-mono text-sm' + (setMissing ? ' border-wrong-icon' : '')}
              />
              <p id={setHint} className="text-sm text-muted-foreground">
                {plain('adminForm.setIdHint', mode)}
              </p>
              {setMissing ? (
                <p id={setError} className="text-sm font-medium text-wrong">
                  {plain('adminForm.needSet', mode)}
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1">
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
                aria-describedby={daysHint}
                className={FIELD + ' tabular-nums sm:max-w-[160px]'}
              />
              <p id={daysHint} className="text-sm text-muted-foreground">
                {plain('adminForm.daysHint', mode)}
                {mounted ? (
                  <>
                    {' '}
                    {plain('adminForm.endsOn', mode)}{' '}
                    <span className="font-medium text-foreground tabular-nums">
                      {utcDay(Date.now() + readDays(days) * DAY_MS)}
                    </span>
                    .
                  </>
                ) : null}
              </p>
              {daysWereFixed(days) ? (
                <p className="text-sm font-medium text-marked">
                  {plain('adminForm.daysFixed', mode)}{' '}
                  <span className="tabular-nums">{readDays(days)}</span>.
                </p>
              ) : null}
            </div>
          </div>
        </fieldset>

        <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row">
          <button
            type="submit"
            disabled={busy}
            aria-label={plain('setAccess.grant', mode)}
            className={PRIMARY_BUTTON}
          >
            <LockOpen aria-hidden="true" className="size-5" />
            {plain(busy ? 'setAccess.saving' : 'setAccess.grant', mode)}
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => void run('revoke')}
            aria-label={plain('setAccess.revoke', mode)}
            className={OUTLINE_BUTTON}
          >
            <Ban aria-hidden="true" className="size-5" />
            {plain('setAccess.revoke', mode)}
          </button>
        </div>
      </form>
    </section>
  );
}
