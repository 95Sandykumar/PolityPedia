'use client';

/**
 * The one read-error state every student screen shares
 * (issue 54a-read-error-core).
 *
 * Why it exists: a failed read used to look exactly like an empty one, so a
 * student whose connection dropped, or whose query hit a missing column, was
 * told "No mock tests yet. Your teacher adds them soon." while the content was
 * there. This is the other half of `EmptyState`: same shape, same rhythm, but
 * it says the read failed and offers one way out.
 *
 * It is a client component ONLY for the Retry button. `router.refresh()` re-runs
 * the server read for the page it sits on, with no full page load and no state
 * lost, so Retry does the one thing its label promises.
 *
 * What it never says: a table, a column, a key, a status code or a Supabase
 * error. A student can do nothing with those, and they tell an attacker where
 * to push. The real reason stays on the server.
 *
 * DESIGN.md section 9, Error: "says what went wrong and the fix, next to the
 * thing that failed". Tokens only, 1 px dashed border, radius 10, no shadow.
 */
import { RefreshCw, WifiOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { IconChip } from '@/components/student-ui';
import { DEFAULT_MODE, plain, type LangMode } from '@/lib/i18n';

export function ReadError({
  mode = DEFAULT_MODE,
  onRetry,
}: {
  mode?: LangMode;
  /**
   * What Retry should do. The default re-runs the server read for this page,
   * which is right for every server-read list. A client list that holds its
   * own rows passes its own reload instead.
   */
  onRetry?: () => void;
}) {
  const router = useRouter();

  return (
    <div
      // The `role="status"` element of its screen, so a screen reader hears it
      // the moment it replaces the list.
      role="status"
      className="flex flex-col items-center gap-3 rounded-[10px] border border-dashed border-border bg-card px-4 py-8 text-center"
    >
      <IconChip Icon={WifiOff} size="lg" className="rounded-full" />
      <p className="max-w-[34ch] text-base leading-6 font-medium">{plain('read.failed', mode)}</p>
      <button
        type="button"
        onClick={() => (onRetry ? onRetry() : router.refresh())}
        className="inline-flex min-h-12 items-center justify-center gap-2 rounded-[10px] bg-primary px-5 text-base font-medium text-primary-foreground transition-colors duration-100"
      >
        <RefreshCw aria-hidden="true" className="size-5" strokeWidth={2} />
        {plain('read.retry', mode)}
      </button>
    </div>
  );
}
