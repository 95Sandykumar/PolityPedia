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
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SignInForm } from '../sign-in-form';
import type { BrowserAuthClient } from '@/lib/auth/types';

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
