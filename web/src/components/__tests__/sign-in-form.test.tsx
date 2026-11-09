/**
 * Issue 03-sign-in: the sign-in screen.
 *
 * The form takes an AuthClient, so the test injects a fake: no real network
 * call and no real key. This is the test the issue asks for: OTP submit calls
 * send-code with the email, and the code step calls verify.
 *
 * Fields are found by role plus accessible name, never by a loose label
 * pattern: "Send code" is also a label, so `/code/i` alone matches the button.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignInForm } from '../sign-in-form';
import type { BrowserAuthClient } from '@/lib/auth/types';
import { AuthRequestError } from '@/lib/auth/sign-in-errors';

function fakeClient(overrides: Partial<BrowserAuthClient> = {}): BrowserAuthClient {
  return {
    sendEmailCode: vi.fn(async () => {}),
    verifyEmailCode: vi.fn(async () => {}),
    ...overrides,
  };
}

const EMAIL = 'student@politypedia.test';

const emailField = () => screen.getByRole('textbox', { name: 'Email' });
const codeField = () => screen.findByRole('textbox', { name: '6-digit code' });
const sendButton = () => screen.getByRole('button', { name: 'Send code' });
const signInButton = () => screen.getByRole('button', { name: 'Sign in' });

function type(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}

/** Fill the email step, submit it, and wait for the code step. */
async function reachCodeStep(email = EMAIL) {
  type(emailField(), email);
  fireEvent.click(sendButton());
  return codeField();
}

describe('SignInForm', () => {
  it('shows a Google button that points at the server route', () => {
    render(<SignInForm client={fakeClient()} />);
    expect(screen.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute(
      'href',
      '/auth/google',
    );
  });

  it('calls send-code with the email when the first step is submitted', async () => {
    const client = fakeClient();
    render(<SignInForm client={client} />);

    type(emailField(), EMAIL);
    fireEvent.click(sendButton());

    await waitFor(() => expect(client.sendEmailCode).toHaveBeenCalledWith(EMAIL));
    expect(client.sendEmailCode).toHaveBeenCalledTimes(1);
  });

  it('moves to the 6-digit code step and calls verify with the email and the code', async () => {
    const client = fakeClient();
    const onSignedIn = vi.fn();
    render(<SignInForm client={client} onSignedIn={onSignedIn} />);

    const code = await reachCodeStep();
    expect(code).toHaveAttribute('maxlength', '6');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');

    type(code, '123456');
    fireEvent.click(signInButton());

    await waitFor(() => expect(client.verifyEmailCode).toHaveBeenCalledWith(EMAIL, '123456'));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
  });

  it('keeps only digits in the code field', async () => {
    render(<SignInForm client={fakeClient()} />);
    const code = await reachCodeStep();
    type(code, '12ab34');
    await waitFor(() => expect((code as HTMLInputElement).value).toBe('1234'));
  });

  it('does not send an empty email', () => {
    const client = fakeClient();
    render(<SignInForm client={client} />);
    fireEvent.click(sendButton());
    expect(client.sendEmailCode).not.toHaveBeenCalled();
  });

  it('does not verify a short code', async () => {
    const client = fakeClient();
    render(<SignInForm client={client} />);
    const code = await reachCodeStep();
    type(code, '123');
    fireEvent.click(signInButton());
    expect(client.verifyEmailCode).not.toHaveBeenCalled();
  });

  it('shows a message and stays on the code step when verify fails', async () => {
    const client = fakeClient({
      verifyEmailCode: vi.fn(async () => {
        throw new Error('bad code');
      }),
    });
    render(<SignInForm client={client} />);

    const code = await reachCodeStep();
    type(code, '000000');
    fireEvent.click(signInButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not sign in/i);
    expect(await codeField()).toBeInTheDocument();
  });

  it('never shows the typed code back inside an error message', async () => {
    const client = fakeClient({
      verifyEmailCode: vi.fn(async () => {
        throw new Error('code 424242 is wrong');
      }),
    });
    render(<SignInForm client={client} />);

    const code = await reachCodeStep();
    type(code, '424242');
    fireEvent.click(signInButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').not.toContain('424242');
  });

  it('renders Hindi labels in hi mode', () => {
    render(<SignInForm client={fakeClient()} mode="hi" />);
    expect(screen.getByRole('button', { name: 'कोड भेजें' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Google से जारी रखें' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'ईमेल' })).toBeInTheDocument();
  });

  it('tells the student when sign-in is not set up yet', () => {
    render(<SignInForm client={fakeClient()} configured={false} />);
    expect(screen.getByRole('status')).toHaveTextContent(/not set up/i);
    expect(screen.queryByRole('button', { name: 'Send code' })).toBeNull();
  });
});

describe('SignInForm: why it failed (issue 64-signin-errors-and-resend)', () => {
  it.each([
    ['denied', /cancelled|did not allow/i],
    ['no_code', /did not send|no code/i],
    ['expired', /took too long|start again/i],
    ['failed', /google sign in failed|could not finish/i],
    ['not_configured', /not set up/i],
  ])('shows a plain message for ?error=%s', (reason, pattern) => {
    render(<SignInForm client={fakeClient()} initialError={reason} />);
    expect(screen.getByRole('alert')).toHaveTextContent(pattern);
  });

  it('shows no banner for an unknown ?error value and never prints it', () => {
    render(<SignInForm client={fakeClient()} initialError="<b>hack</b>" />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.textContent).not.toContain('hack');
  });

  it('clears the banner when the student asks for a code', async () => {
    render(<SignInForm client={fakeClient()} initialError="denied" />);
    await reachCodeStep();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names both causes for a code that does not work (83-fix-wrong-code-says-expired)', async () => {
    const verify = vi.fn().mockRejectedValue(new AuthRequestError(401, 'bad_code'));
    render(<SignInForm client={fakeClient({ verifyEmailCode: verify })} />);
    const code = await reachCodeStep();
    type(code, '111111');
    fireEvent.click(signInButton());
    const message = (await screen.findByRole('alert')).textContent ?? '';
    expect(message).toMatch(/wrong/i);
    expect(message).toMatch(/expired/i);
    expect(message).toMatch(/resend/i);
    expect(document.body.textContent).not.toContain('111111');
  });

  it('tells the student to wait when the email limit is hit on send', async () => {
    const client = fakeClient({
      sendEmailCode: vi.fn(async () => {
        throw new AuthRequestError(429, 'rate_limited');
      }),
    });
    render(<SignInForm client={client} />);
    type(emailField(), EMAIL);
    fireEvent.click(sendButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/wait .* try again/i);
  });

  it('tells the student to wait when the email limit is hit on verify', async () => {
    const client = fakeClient({
      verifyEmailCode: vi.fn(async () => {
        throw new AuthRequestError(429, 'rate_limited');
      }),
    });
    render(<SignInForm client={client} />);
    const code = await reachCodeStep();
    type(code, '123456');
    fireEvent.click(signInButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/wait .* try again/i);
  });

  it('keeps the generic message for an unknown failure', async () => {
    const client = fakeClient({
      verifyEmailCode: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    render(<SignInForm client={client} />);
    const code = await reachCodeStep();
    type(code, '123456');
    fireEvent.click(signInButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not sign in/i);
  });
});

describe('SignInForm: resend (issue 64-signin-errors-and-resend)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const resend = () => screen.getByRole('button', { name: /resend code/i });

  it('shows the spam hint and an expiry line on the code step', async () => {
    render(<SignInForm client={fakeClient()} />);
    await reachCodeStep();
    expect(screen.getByText(/check your spam folder/i)).toBeInTheDocument();
    expect(screen.getByText('The code expires soon.')).toBeInTheDocument();
  });

  it('locks Resend for 30 seconds, counts down, then sends again', async () => {
    vi.useFakeTimers();
    const client = fakeClient();
    render(<SignInForm client={client} />);

    type(emailField(), EMAIL);
    await act(async () => {
      fireEvent.click(sendButton());
    });
    expect(client.sendEmailCode).toHaveBeenCalledTimes(1);

    expect(resend()).toBeDisabled();
    expect(resend()).toHaveTextContent('30');

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(resend()).toBeDisabled();
    expect(resend()).toHaveTextContent('20');

    act(() => {
      vi.advanceTimersByTime(19_000);
    });
    expect(resend()).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(resend()).toBeEnabled();
    expect(resend()).toHaveTextContent(/^Resend code$/);

    await act(async () => {
      fireEvent.click(resend());
    });
    expect(client.sendEmailCode).toHaveBeenCalledTimes(2);
    expect(client.sendEmailCode).toHaveBeenLastCalledWith(EMAIL);
    expect(resend()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/new code/i);
  });

  it('shows the wait message when a resend hits the email limit', async () => {
    vi.useFakeTimers();
    const send = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new AuthRequestError(429, 'rate_limited'));
    render(<SignInForm client={fakeClient({ sendEmailCode: send })} />);
    type(emailField(), EMAIL);
    await act(async () => {
      fireEvent.click(sendButton());
    });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    await act(async () => {
      fireEvent.click(resend());
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/wait .* try again/i);
  });

  it('has Hindi labels for resend and the spam hint', async () => {
    render(<SignInForm client={fakeClient()} mode="hi" />);
    type(screen.getByRole('textbox', { name: 'ईमेल' }), EMAIL);
    fireEvent.click(screen.getByRole('button', { name: 'कोड भेजें' }));
    await screen.findByRole('textbox', { name: '6 अंकों का कोड' });
    expect(screen.getByRole('button', { name: /कोड दोबारा भेजें/ })).toBeInTheDocument();
    expect(screen.getByText(/स्पैम/)).toBeInTheDocument();
  });
});
