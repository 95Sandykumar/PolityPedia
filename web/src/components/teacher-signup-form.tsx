'use client';

/**
 * Teacher signup with an invite code (issue 05-teacher-invite-approval).
 *
 * Teacher signup is invite only (V1, F-A1). The code is spent by a SQL
 * function, which is also where single use is enforced, so this screen only
 * collects the code and reports one of two outcomes.
 *
 * The client is a prop so the test can inject a fake: no real network call and
 * no real key in any test (web/CLAUDE.md).
 *
 * Security: one fixed failure message. "Used already" and "never existed" must
 * look the same, or this form becomes a code checker.
 */
import { useMemo, useState } from 'react';
import { createBrowserTeacherSignupClient } from '@/lib/teachers/browser-teachers-client';
import { MAX_INVITE_CODE_LENGTH, type TeacherSignupClient } from '@/lib/teachers/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';

/** DESIGN.md: 48 px touch target, radius 10, 1 px border, tokens only. */
const FIELD =
  'min-h-12 w-full rounded-[10px] border border-border bg-card px-3 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';
const PRIMARY_BUTTON =
  'min-h-12 w-full rounded-[10px] bg-primary px-3 text-base font-medium text-white transition-colors duration-100 disabled:opacity-60';

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

export function TeacherSignupForm({
  client,
  mode = DEFAULT_MODE,
  configured = true,
}: {
  client?: TeacherSignupClient;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const fallback = useMemo(() => createBrowserTeacherSignupClient(), []);
  const signup = client ?? fallback;

  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);

  const title = (
    <h1 className="text-[22px] leading-7 font-bold">
      <Lines keyName="teacherSignup.title" mode={mode} />
    </h1>
  );

  if (!configured) {
    return (
      <section className="flex flex-col gap-3">
        {title}
        <p role="status" className="text-muted-foreground">
          {plain('teacherSignup.notConfigured', mode)}
        </p>
      </section>
    );
  }

  async function submit() {
    const trimmed = code.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await signup.redeem(trimmed);
      setDone(true);
    } catch {
      // Fixed message only: the thrown error may quote Postgres.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  // Done is a dead end on purpose: an admin has to act next, so there is
  // nothing useful left on this screen.
  if (done) {
    return (
      <section className="flex flex-col gap-3">
        {title}
        <p role="status" className="rounded-[10px] border border-border bg-card p-3 text-correct">
          {plain('teacherSignup.done', mode)}
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      {title}
      <p className="text-sm text-muted-foreground">{plain('teacherSignup.hint', mode)}</p>

      {failed ? (
        <p role="alert" className="rounded-[10px] border border-border bg-card p-3 text-wrong">
          {plain('teacherSignup.failed', mode)}
        </p>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-3"
        noValidate
      >
        <label htmlFor="teacher-invite-code" className="text-sm font-medium">
          <Lines keyName="teacherSignup.code" mode={mode} />
        </label>
        <input
          id="teacher-invite-code"
          name="code"
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_INVITE_CODE_LENGTH}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          className={FIELD + ' font-mono text-sm'}
        />

        <button
          type="submit"
          disabled={busy}
          aria-label={plain('teacherSignup.submit', mode)}
          className={PRIMARY_BUTTON}
        >
          {plain(busy ? 'teacherSignup.sending' : 'teacherSignup.submit', mode)}
        </button>
      </form>
    </section>
  );
}
