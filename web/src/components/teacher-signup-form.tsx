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
import { GraduationCap } from 'lucide-react';
import { BOX, BrandMark, CARD, Lines, PRIMARY_BUTTON, Steps } from '@/components/teacher-ui';
import { DEFAULT_MODE, plain, type LangMode } from '@/lib/i18n';

/** DESIGN.md: 48 px touch target, radius 10, 1 px border, tokens only. */
const FIELD = `${BOX} font-mono text-sm`;

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

  // The same head on every state of this screen: the mark, the icon tile, the
  // title. A visitor who is not signed in yet sees one calm, simple card.
  const title = (
    <>
      <BrandMark mode={mode} />
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
        >
          <GraduationCap size={24} strokeWidth={2} />
        </span>
        <h1 className="text-[22px] leading-7 font-bold">
          <Lines keyName="teacherSignup.title" mode={mode} />
        </h1>
      </div>
    </>
  );

  if (!configured) {
    return (
      <section className="flex flex-col gap-4">
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
      <section className="flex flex-col gap-4">
        {title}
        <p role="status" className="rounded-[10px] bg-primary/10 p-3 font-medium text-primary">
          {plain('teacherSignup.done', mode)}
        </p>
        <div className={`${CARD} p-4`}>
          <Steps
            mode={mode}
            steps={[
              { key: 'teacherUi.stepCode', state: 'done' },
              { key: 'teacherUi.stepReview', state: 'now' },
              { key: 'teacherUi.stepOpen', state: 'next' },
            ]}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      {title}
      <p className="text-muted-foreground">{plain('teacherSignup.hint', mode)}</p>

      {failed ? (
        <p role="alert" className="rounded-[10px] border border-wrong bg-wrong-soft p-3 text-wrong">
          {plain('teacherSignup.failed', mode)}
        </p>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className={`${CARD} flex flex-col gap-3 p-4`}
        noValidate
      >
        <label htmlFor="teacher-invite-code" className="text-sm font-medium text-muted-foreground">
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
          className={FIELD}
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
