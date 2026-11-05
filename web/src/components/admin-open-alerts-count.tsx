'use client';

/**
 * How many money alerts are open, as a badge on the Admin home
 * (issue 35-reconcile-visible).
 *
 * The nightly reconcile is a 2 AM job and the admin home is where Boss starts.
 * A link alone is not enough: nobody opens a page that might be empty, and
 * "there are 3 open alerts" is the one number that makes Boss open it.
 *
 * IT SHOWS NOTHING when the count is zero, and NOTHING when the read failed.
 * A zero badge is noise on the good days, and a zero badge after a failed read
 * is a lie about money. Silence means "no news here"; the page itself says
 * "could not load" out loud.
 *
 * The client is a prop so the test can inject a fake: no real network call and
 * no real key (web/CLAUDE.md).
 */
import { useEffect, useMemo, useState } from 'react';
import { createBrowserAlertsClient } from '@/lib/ledger/browser-alerts-client';
import type { BrowserAlertsClient } from '@/lib/ledger/types';
import { DEFAULT_MODE, plain, type LangMode } from '@/lib/i18n';

export function AdminOpenAlertsCount({
  client,
  mode = DEFAULT_MODE,
}: {
  client?: BrowserAlertsClient;
  mode?: LangMode;
}) {
  const fallback = useMemo(() => createBrowserAlertsClient(), []);
  const alerts = client ?? fallback;
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const rows = await alerts.list();
        if (live) setCount(rows.length);
      } catch {
        // Stays null. A wrong zero beside a money link is worse than no badge.
        if (live) setCount(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [alerts]);

  if (count === null || count === 0) return null;

  return (
    <span className="flex items-center gap-1 text-sm font-bold text-wrong tabular-nums">
      <span>{count}</span>
      <span className="font-medium text-muted-foreground">{plain('alerts.open', mode)}</span>
    </span>
  );
}
