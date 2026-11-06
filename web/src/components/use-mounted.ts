'use client';

import { useSyncExternalStore } from 'react';

/**
 * False on the server and on the first client render, true afterwards. It keeps
 * anything that reads the clock (the admin forms' "Ends on" date) out of the
 * server HTML, so the server and the browser never disagree about a date.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}
