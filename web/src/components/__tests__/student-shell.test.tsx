import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StudentShell } from '../student-shell';

vi.mock('next/navigation', () => ({ usePathname: () => '/teachers' }));

const EN = ['Home', 'Teachers', 'Practice', 'Saved', 'Me'];
const HI = ['होम', 'शिक्षक', 'अभ्यास', 'सेव', 'मैं'];

describe('StudentShell', () => {
  it('renders exactly 5 tab links with English labels by default', () => {
    render(<StudentShell>page</StudentShell>);
    const nav = screen.getByRole('navigation');
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(5);
    expect(links.map((l) => l.getAttribute('aria-label'))).toEqual(EN);
  });

  it('renders Hindi labels when mode is hi', () => {
    render(<StudentShell mode="hi">page</StudentShell>);
    const links = within(screen.getByRole('navigation')).getAllByRole('link');
    expect(links).toHaveLength(5);
    expect(links.map((l) => l.getAttribute('aria-label'))).toEqual(HI);
  });

  it('shows English with Hindi under it in both mode', () => {
    render(<StudentShell mode="both">page</StudentShell>);
    const links = within(screen.getByRole('navigation')).getAllByRole('link');
    expect(links[0]).toHaveTextContent('Homeहोम');
  });

  it('links to the 5 placeholder routes and marks the current tab', () => {
    render(<StudentShell>page</StudentShell>);
    const links = within(screen.getByRole('navigation')).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/',
      '/teachers',
      '/practice',
      '/saved',
      '/me',
    ]);
    expect(links[1]).toHaveAttribute('aria-current', 'page');
    expect(links[0]).not.toHaveAttribute('aria-current');
  });

  it('renders the page content', () => {
    render(<StudentShell>hello page</StudentShell>);
    expect(screen.getByText('hello page')).toBeInTheDocument();
  });
});
