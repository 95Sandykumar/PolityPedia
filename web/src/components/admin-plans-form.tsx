'use client';

/**
 * Admin screen: give a student a plan, or end it (issue 21-plans-entitlements,
 * laid out again in the admin-ui pass).
 *
 * This is the "for testing" door in the definition of done. Payments are a
 * later slice, so the only source this screen writes is `admin`.
 *
 * The client is a prop so the test can inject a fake: no real network call and
 * no real key in any test (web/CLAUDE.md).
 *
 * Security: the real gate is the `entitlements_admin_all` RLS policy inside
 * Postgres. This form is convenience, not permission, and it shows one fixed
 * failure message so a policy name never reaches the page.
 *
 * Source: hand-built from DESIGN.md tokens (grouped fieldsets, hint + error
 * under each field, Lucide icons).
 */
import { useId, useMemo, useRef, useState } from 'react';
import { Ban, CheckCheck } from 'lucide-react';
import { createBrowserPlansClient } from '@/lib/plans/browser-plans-client';
import { isPlan, type AdminPlansClient, type Plan } from '@/lib/plans/types';
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

/** Clamp to 1..365 days. A typo must not hand out a ten-year plan. */
function readDays(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(1, parsed));
}

/** True when what was typed is not already a whole number in 1..365. */
function daysWereFixed(value: string): boolean {
  const parsed = Number.parseInt(value, 10);
  return !Number.isFinite(parsed) || parsed < 1 || parsed > MAX_DAYS || String(parsed) !== value.trim();
}

export function AdminPlansForm({
  client,
  mode = DEFAULT_MODE,
  configured = true,
}: {
  client?: AdminPlansClient;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const fallback = useMemo(() => createBrowserPlansClient(), []);
  const plans = client ?? fallback;

  const [userId, setUserId] = useState('');
  const [plan, setPlan] = useState<Plan>('ai');
  const [days, setDays] = useState(String(DEFAULT_DAYS));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'granted' | 'ended' | null>(null);
  const [failed, setFailed] = useState(false);
  /** Set when a press found the user ID empty, so the message can show. */
  const [attempted, setAttempted] = useState(false);
  const userRef = useRef<HTMLInputElement>(null);
  const mounted = useMounted();
  const ids = useId();

  const title = <Lines keyName="plans.title" mode={mode} />;

  if (!configured) {
    return (
      <section className="flex flex-col gap-4">
        <PageHeader title={title} />
        <Banner tone="info" role="status">
          {plain('plans.notConfigured', mode)}
        </Banner>
      </section>
    );
  }

  async function run(action: 'grant' | 'end') {
    const student = userId.trim();
    if (!student) {
      setAttempted(true);
      userRef.current?.focus();
      return;
    }
    if (busy) return;
    setBusy(true);
    setFailed(false);
    setDone(null);
    try {
      if (action === 'grant') {
        const validUntil = new Date(Date.now() + readDays(days) * DAY_MS).toISOString();
        await plans.grant({ userId: student, plan, validUntil });
        setDone('granted');
      } else {
        await plans.end({ userId: student, plan });
        setDone('ended');
      }
    } catch {
      // Fixed message only: the thrown error may quote Postgres.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const userMissing = attempted && userId.trim() === '';
  const userHint = ids + '-user-hint';
  const userError = ids + '-user-error';
  const daysHint = ids + '-days-hint';

  return (
    <section className="flex flex-col gap-4">
      <PageHeader title={title} hint={plain('plans.hint', mode)} />

      {failed ? (
        <Banner tone="error" role="alert">
          {plain('plans.failed', mode)}
        </Banner>
      ) : null}

      {done ? (
        <Banner tone="success" role="status">
          {plain(done === 'granted' ? 'plans.granted' : 'plans.ended', mode)}
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
            <label htmlFor="plans-user-id" className="text-sm font-medium">
              <Lines keyName="plans.userId" mode={mode} />
            </label>
            <input
              ref={userRef}
              id="plans-user-id"
              name="userId"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              aria-invalid={userMissing || undefined}
              aria-describedby={userMissing ? userError + ' ' + userHint : userHint}
              className={
                FIELD + ' font-mono text-sm' + (userMissing ? ' border-wrong-icon' : '')
              }
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
            {plain('adminForm.groupPlan', mode)}
          </legend>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="plans-plan" className="text-sm font-medium">
                <Lines keyName="plans.plan" mode={mode} />
              </label>
              <select
                id="plans-plan"
                name="plan"
                value={plan}
                onChange={(event) => {
                  if (isPlan(event.target.value)) setPlan(event.target.value);
                }}
                className={FIELD}
              >
                <option value="ai">{plain('plans.planAi', mode)}</option>
                <option value="pro">{plain('plans.planPro', mode)}</option>
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="plans-days" className="text-sm font-medium">
                <Lines keyName="plans.days" mode={mode} />
              </label>
              <input
                id="plans-days"
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
            aria-label={plain('plans.grant', mode)}
            className={PRIMARY_BUTTON}
          >
            <CheckCheck aria-hidden="true" className="size-5" />
            {plain(busy ? 'plans.saving' : 'plans.grant', mode)}
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => void run('end')}
            aria-label={plain('plans.end', mode)}
            className={OUTLINE_BUTTON}
          >
            <Ban aria-hidden="true" className="size-5" />
            {plain('plans.end', mode)}
          </button>
        </div>
      </form>
    </section>
  );
}
