/**
 * Issue 33-session-refresh: the Sign out button on the Me tab.
 *
 * On a shared phone the session stayed for 7 days because nothing ever
 * cleared the cookie. This button is a plain form POST, so it still works
 * when the page JavaScript has not loaded on a bad 4G connection.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SignOutButton } from '../sign-out-button';
import { SIGN_OUT_PATH } from '@/lib/auth/browser-auth-client';

describe('SignOutButton', () => {
  it('posts to the sign-out route', () => {
    render(<SignOutButton mode="en" />);
    const button = screen.getByRole('button', { name: 'Sign out' });
    const form = button.closest('form');
    expect(form).not.toBeNull();
    expect(form?.getAttribute('action')).toBe(SIGN_OUT_PATH);
    expect(form?.getAttribute('method')?.toLowerCase()).toBe('post');
  });

  it('shows both languages in both mode', () => {
    render(<SignOutButton mode="both" />);
    expect(screen.getByText('Sign out')).toBeInTheDocument();
    expect(screen.getByText('साइन आउट')).toBeInTheDocument();
  });

  it('shows the Hindi label in Hindi mode', () => {
    render(<SignOutButton mode="hi" />);
    expect(screen.getByRole('button', { name: 'साइन आउट' })).toBeInTheDocument();
  });

  it('keeps the 48 px touch target DESIGN.md section 5 asks for', () => {
    render(<SignOutButton mode="en" />);
    expect(screen.getByRole('button', { name: 'Sign out' }).className).toContain('min-h-12');
  });
});
