/**
 * Issue 78-installable-app: the Install app button on the Me tab.
 * Shown only when the browser offers install. On iOS, a one line hint instead.
 *
 * Issue 82-fix-install-button-missed-event: the browser fires
 * `beforeinstallprompt` once, soon after the page loads. A student who opens
 * Home and then taps Me mounts `InstallApp` long after that moment, so the
 * offer is held by the always mounted register in the root layout instead.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallApp } from '../install-app';
import { ServiceWorkerRegister } from '../service-worker-register';

function offerInstall(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: string }>;
  };
  event.prompt = vi.fn(async () => {});
  event.userChoice = Promise.resolve({ outcome });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';

describe('InstallApp', () => {
  // The held offer lives on a module variable, so it outlives one test.
  // `appinstalled` is the app's own way of saying "drop it": no test only door.
  beforeEach(() => {
    act(() => {
      window.dispatchEvent(new Event('appinstalled'));
    });
  });

  it('shows nothing until the browser offers install', () => {
    render(<InstallApp mode="en" userAgent={ANDROID} />);
    expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull();
    expect(screen.queryByText(/Add to Home Screen/)).toBeNull();
  });

  it('shows the button once the browser offers install, and holds the prompt for the tap', () => {
    render(<InstallApp mode="en" userAgent={ANDROID} />);
    const event = offerInstall();
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByRole('button', { name: 'Install app' })).toBeInTheDocument();
  });

  it('shows the button when the event fired before the student reached Me', () => {
    // Home: only the root layout's register is mounted, and it catches the event.
    render(<ServiceWorkerRegister serviceWorker={{ register: vi.fn() }} enabled={false} />);
    const event = offerInstall();
    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull();

    // The student now taps Me, long after the browser fired the event.
    cleanup();
    render(<InstallApp mode="en" userAgent={ANDROID} />);
    expect(screen.getByRole('button', { name: 'Install app' })).toBeInTheDocument();
  });

  it('opens the browser prompt on tap, then hides the button', async () => {
    render(<InstallApp mode="en" userAgent={ANDROID} />);
    const event = offerInstall('accepted');
    fireEvent.click(screen.getByRole('button', { name: 'Install app' }));
    await waitFor(() => expect(event.prompt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull());
  });

  it('does not offer the same prompt again on a later visit to Me', async () => {
    render(<InstallApp mode="en" userAgent={ANDROID} />);
    const event = offerInstall('dismissed');
    fireEvent.click(screen.getByRole('button', { name: 'Install app' }));
    await waitFor(() => expect(event.prompt).toHaveBeenCalledTimes(1));

    cleanup();
    render(<InstallApp mode="en" userAgent={ANDROID} />);
    expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull();
  });

  it('hides the button when the app is installed', () => {
    render(<InstallApp mode="en" userAgent={ANDROID} />);
    offerInstall();
    act(() => {
      window.dispatchEvent(new Event('appinstalled'));
    });
    expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull();
  });

  it('shows the Add to Home Screen hint on iOS, and no button', () => {
    render(<InstallApp mode="en" userAgent={IPHONE} />);
    expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull();
  });

  it('shows no iOS hint when the app already runs standalone', () => {
    render(<InstallApp mode="en" userAgent={IPHONE} standalone />);
    expect(screen.queryByText(/Add to Home Screen/)).toBeNull();
  });

  it('shows both languages in both mode', () => {
    render(<InstallApp mode="both" userAgent={ANDROID} />);
    offerInstall();
    expect(screen.getByText('Install app')).toBeInTheDocument();
    expect(screen.getByText('ऐप इंस्टॉल करें')).toBeInTheDocument();
  });

  it('shows Hindi in Hindi mode', () => {
    render(<InstallApp mode="hi" userAgent={ANDROID} />);
    offerInstall();
    expect(screen.getByRole('button', { name: 'ऐप इंस्टॉल करें' })).toBeInTheDocument();
  });
});
