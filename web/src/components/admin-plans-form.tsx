'use client';

/**
 * Admin screen: give a student a plan, or end it (issue 21-plans-entitlements).
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
 */
import { useMemo, useState } from 'react';
import { createBrowserPlansClient } from '@/lib/plans/browser-plans-client';
import { isPlan, type AdminPlansClient, type Plan } from '@/lib/plans/types';
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

/** Clamp to 1..365 days. A typo must not hand out a ten-year plan. */
function readDays(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(1, parsed));
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

  const title = (
    <h1 className="text-[22px] leading-7 font-bold">
      <Lines keyName="plans.title" mode={mode} />
    </h1>
  );

  if (!configured) {
    return (
      <section className="flex flex-col gap-3">
        {title}
        <p role="status" className="text-muted-foreground">
          {plain('plans.notConfigured', mode)}
        </p>
      </section>
    );
  }

  async function run(action: 'grant' | 'end') {
    const student = userId.trim();
    if (!student || busy) return;
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

  return (
    <section className="flex flex-col gap-3">
      {title}
      <p className="text-sm text-muted-foreground">{plain('plans.hint', mode)}</p>

      {failed ? (
        <p role="alert" className="rounded-[10px] border border-border bg-card p-3 text-wrong">
          {plain('plans.failed', mode)}
        </p>
      ) : null}

      {done ? (
        <p role="status" className="rounded-[10px] border border-border bg-card p-3 text-correct">
          {plain(done === 'granted' ? 'plans.granted' : 'plans.ended', mode)}
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
        <label htmlFor="plans-user-id" className="text-sm font-medium">
          <Lines keyName="plans.userId" mode={mode} />
        </label>
        <input
          id="plans-user-id"
          name="userId"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
          className={FIELD + ' font-mono text-sm'}
        />

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
          className={FIELD + ' tabular-nums'}
        />

        <button
          type="submit"
          disabled={busy}
          aria-label={plain('plans.grant', mode)}
          className={PRIMARY_BUTTON}
        >
          {plain(busy ? 'plans.saving' : 'plans.grant', mode)}
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => void run('end')}
          aria-label={plain('plans.end', mode)}
          className={OUTLINE_BUTTON}
        >
          {plain('plans.end', mode)}
        </button>
      </form>
    </section>
  );
}
