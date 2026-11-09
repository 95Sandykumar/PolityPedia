/**
 * The logged-out screens (issue 63-public-landing).
 *
 * Two components, both server-safe (no state, no client hook), so these are
 * plain render tests: no fake network and no key anywhere.
 *
 * What they must prove:
 *  1. the landing answers "what is this" in one line (UGC NET, CUET PG), has
 *     a "Try a free test" button, a "Sign in" button, and three short lines
 *     of how it works.
 *  2. the public teacher card shows the PUBLIC fields only and offers
 *     "Sign in to follow" instead of the real Follow button.
 *  3. neither one ever prints the old "not set up yet" line, which read as
 *     "the app is broken" to a first visitor (persona-1 gap 3).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PublicLanding, PublicTeacherCard } from '@/components/public-landing';
import { dictionary } from '@/lib/i18n';
import type { PublicTeacher } from '@/lib/teachers/types';

const ALIAS_TEACHER: PublicTeacher = {
  userId: '44444444-4444-4444-8444-444444444444',
  identityMode: 'alias',
  displayName: 'Polity Guru',
  avatarPath: 'avatars/owl.png',
  bioEn: 'Teaches polity',
  bioHi: 'राजनीति पढ़ाते हैं',
  videosVisible: true,
};

function hrefs(): string[] {
  return [...document.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
}

describe('PublicLanding', () => {
  it('names the exams in the pitch, so the 5 second test passes', () => {
    render(<PublicLanding mode="en" />);
    const pitch = screen.getByText(dictionary.en['land.pitch']);
    expect(pitch.textContent).toContain('UGC NET');
    expect(pitch.textContent).toContain('CUET PG');
  });

  it('shows the brand name, not a bare "Home"', () => {
    render(<PublicLanding mode="en" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(
      dictionary.en['sui.brand'],
    );
  });

  it('offers a free test and a sign in, both pointing at /sign-in', () => {
    render(<PublicLanding mode="en" />);
    const free = screen.getByRole('link', { name: dictionary.en['land.tryFree'] });
    const signIn = screen.getByRole('link', { name: dictionary.en['land.signIn'] });
    expect(free).toHaveAttribute('href', '/sign-in');
    expect(signIn).toHaveAttribute('href', '/sign-in');
  });

  it('explains how it works in exactly three short lines', () => {
    render(<PublicLanding mode="en" />);
    const list = screen.getByRole('list', { name: dictionary.en['land.howTitle'] });
    expect(list.querySelectorAll('li')).toHaveLength(3);
    for (const key of ['land.how1', 'land.how2', 'land.how3'] as const) {
      expect(screen.getByText(dictionary.en[key])).toBeTruthy();
    }
  });

  it('never says "not set up yet" to a first visitor', () => {
    render(<PublicLanding mode="en" />);
    expect(document.body.textContent).not.toContain('not set up yet');
  });

  it('shows both languages in both mode, English first', () => {
    render(<PublicLanding mode="both" />);
    expect(screen.getByText(dictionary.en['land.pitch'])).toBeTruthy();
    expect(screen.getByText(dictionary.hi['land.pitch'])).toBeTruthy();
  });

  it('leaves no link pointing anywhere a logged-out visitor cannot go', () => {
    render(<PublicLanding mode="en" />);
    for (const href of hrefs()) expect(href).toBe('/sign-in');
  });
});

describe('PublicTeacherCard', () => {
  it('titles the page with the name the view handed over, the alias', () => {
    render(<PublicTeacherCard teacher={ALIAS_TEACHER} mode="en" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Polity Guru');
  });

  it('shows the public bio', () => {
    render(<PublicTeacherCard teacher={ALIAS_TEACHER} mode="en" />);
    expect(screen.getByText('Teaches polity')).toBeTruthy();
  });

  it('offers "Sign in to follow", never a working Follow button', () => {
    render(<PublicTeacherCard teacher={ALIAS_TEACHER} mode="en" />);
    expect(
      screen.getByRole('link', { name: dictionary.en['land.signInToFollow'] }),
    ).toHaveAttribute('href', '/sign-in');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('still tells the visitor what PolityPedia is, so a shared link sells', () => {
    render(<PublicTeacherCard teacher={ALIAS_TEACHER} mode="en" />);
    expect(screen.getByText(dictionary.en['land.pitch'])).toBeTruthy();
  });

  it('shows the alias avatar only: the view carries no real photo', () => {
    render(<PublicTeacherCard teacher={ALIAS_TEACHER} mode="en" />);
    const img = document.querySelector('img');
    expect(img).toHaveAttribute('src', 'avatars/owl.png');
  });
});
