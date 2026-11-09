/**
 * The held install offer (issue 82-fix-install-button-missed-event).
 *
 * The browser fires `beforeinstallprompt` ONCE, soon after the page loads. The
 * Install button lives on Me, and a student usually reaches Me by tapping, long
 * after that moment. So the listener cannot live in the button: it lives here,
 * started by the always mounted register in the root layout, and the event is
 * kept on a module variable until something asks for it.
 *
 * No React, no state library: one variable plus a set of watchers, so a server
 * render touches nothing.
 */

/** The (non standard) event Chrome and Edge fire when the app can be installed. */
export type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};

type Watcher = (offer: InstallPromptEvent | null) => void;

let held: InstallPromptEvent | null = null;
let listening = false;
const watchers = new Set<Watcher>();

function tell(): void {
  for (const watcher of [...watchers]) watcher(held);
}

/**
 * Starts listening, once per page load. Safe to call from several components and
 * on every mount: the second call does nothing.
 */
export function captureInstallPrompt(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('beforeinstallprompt', (event: Event) => {
    event.preventDefault(); // hold it: the browser's own bar would show at a random moment
    held = event as InstallPromptEvent;
    tell();
  });
  window.addEventListener('appinstalled', () => {
    held = null;
    tell();
  });
}

/** The offer the browser made, or `null` when it made none. */
export function heldInstallPrompt(): InstallPromptEvent | null {
  return held;
}

/** Drops the offer. One prompt per event: it cannot be shown twice. */
export function clearInstallPrompt(): void {
  if (!held) return;
  held = null;
  tell();
}

/** Calls `watcher` whenever the offer appears or goes. Returns the unsubscribe. */
export function watchInstallPrompt(watcher: Watcher): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}
