'use client';

/**
 * The student's join screen (issue 19-batches).
 *
 * V2: "Student joins by link or code". Both ways land here. The link fills the
 * field from the path, so the student taps one button; a student who was given
 * the code by voice types it into the same field. One screen, two ways in, and
 * nothing to explain.
 *
 * The code is normalised before it travels (upper case, spaces and dashes
 * dropped), because it arrives by WhatsApp and gets typed with a space on the
 * end. A code holding a character the generator never uses (O, 0, I, 1) is
 * refused HERE, with no request: it was mistyped, and a round trip would come
 * back saying the same thing more slowly.
 *
 * A bad code and an unknown code read the same line. The difference is not
 * the student's to act on, and spelling it out would turn the screen into a
 * tool for guessing other teachers' codes.
 *
 * The grant itself is a trigger in `0019_batches.sql`, so by the time this
 * screen says "You are in", the batch's free sets are already open. There is
 * no second button.
 *
 * The `BrowserBatchesClient` is a prop so the test can inject a fake: no real
 * network call and no key in any test (web/CLAUDE.md).
 */
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { createBrowserBatchesClient } from '@/lib/batches/browser-batches-client';
import {
  normalizeJoinCode,
  type BrowserBatchesClient,
} from '@/lib/batches/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';

const PRIMARY_BUTTON =
  'min-h-12 w-full rounded-[10px] bg-primary px-3 text-base font-medium text-primary-foreground transition-colors duration-100 disabled:opacity-60';

const BOX =
  'min-h-12 w-full rounded-[10px] border border-border bg-card px-3 text-base font-mono tracking-widest text-foreground uppercase';

const CARD = 'rounded-[10px] border border-border bg-card p-3';

/** The code the client throws -> the one line the student reads. */
const PROBLEM_LABELS: Record<string, MessageKey> = {
  'bad-code': 'join.badCode',
};

export function JoinBatch({
  code,
  client,
  mode = DEFAULT_MODE,
  configured = true,
}: {
  /** The code out of `/join/<code>`, or empty when the student came by hand. */
  code: string;
  client?: BrowserBatchesClient;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const fallback = useMemo(() => createBrowserBatchesClient(), []);
  const data = client ?? fallback;

  const [typed, setTyped] = useState(() => normalizeJoinCode(code) ?? code.toUpperCase());
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);

  if (!configured) {
    return (
      <section className="flex flex-col gap-3">
        <Title mode={mode} />
        <p role="status" className="text-muted-foreground">
          {plain('join.notConfigured', mode)}
        </p>
      </section>
    );
  }

  async function join(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setProblem(null);

    const clean = normalizeJoinCode(typed);
    if (!clean) {
      setProblem('join.badCode');
      return;
    }

    setBusy(true);
    try {
      await data.join(clean);
      setJoined(true);
    } catch (cause) {
      // Our own short code, or the generic line. Never a server message.
      const found = (cause as Error)?.message ?? '';
      setProblem(PROBLEM_LABELS[found] ?? 'join.failed');
    } finally {
      setBusy(false);
    }
  }

  if (joined) {
    return (
      <section className="flex flex-col gap-3">
        <Title mode={mode} />
        <p role="status" className={`${CARD} text-foreground`}>
          {plain('join.done', mode)}
        </p>
        {/* Straight on to what the batch just unlocked. B3: no prefetch. */}
        <Link href="/teachers" prefetch={false} className={PRIMARY_BUTTON + ' text-center leading-[3rem]'}>
          {plain('join.mocks', mode)}
        </Link>
      </section>
    );
  }

  return (
    <form onSubmit={join} className="flex flex-col gap-3" noValidate>
      <Title mode={mode} />
      <p className="text-muted-foreground">{plain('join.hint', mode)}</p>

      {problem ? (
        <p role="alert" className={`${CARD} text-wrong`}>
          {plain(problem, mode)}
        </p>
      ) : null}

      <label className="flex w-full flex-col gap-1">
        <span className="text-sm font-medium text-muted-foreground">
          {labels('join.code', mode).map((line, index) => (
            <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
              {line}
            </span>
          ))}
        </span>
        <input
          type="text"
          value={typed}
          // The longest code the CHECK constraint allows.
          maxLength={12}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          aria-label={plain('join.code', mode)}
          onChange={(event) => setTyped(event.target.value.toUpperCase())}
          className={BOX}
        />
      </label>

      <button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
        {plain(busy ? 'join.joining' : 'join.join', mode)}
      </button>
    </form>
  );
}

function Title({ mode }: { mode: LangMode }) {
  return (
    <h1 className="text-xl font-semibold text-foreground">
      {labels('join.title', mode).map((line, index) => (
        <span key={line} className={index === 0 ? 'block' : 'block text-base font-normal'}>
          {line}
        </span>
      ))}
    </h1>
  );
}
