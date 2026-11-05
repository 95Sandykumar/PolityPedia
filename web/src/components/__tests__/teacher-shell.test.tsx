/**
 * Teacher dashboard shell (issue 07-next-exam-date-teacher-shell).
 *
 * DESIGN.md section 7: "Teacher dashboard: left sidebar on laptop, the same 5
 * slots as a bottom nav on phone: Home, Papers, Mock sets, Batches, Profile."
 *
 * One nav element, not two, so a screen reader hears one menu and the laptop
 * and phone layouts can never list different slots. The switch is CSS only.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TeacherShell } from '../teacher-shell';

vi.mock('next/navigation', () => ({ usePathname: () => '/teacher/papers' }));

const EN = ['Home', 'Papers', 'Mock sets', 'Batches', 'Profile'];
const HI = ['होम', 'पेपर', 'मॉक सेट', 'बैच', 'प्रोफ़ाइल'];

const PATHS = [
  '/teacher/home',
  '/teacher/papers',
  '/teacher/mocks',
  '/teacher/batches',
  '/teacher/profile',
];

describe('TeacherShell', () => {
  it('renders exactly 5 slots with English labels by default', () => {
    render(<TeacherShell>page</TeacherShell>);
    const links = within(screen.getByRole('navigation')).getAllByRole('link');
    expect(links).toHaveLength(5);
    expect(links.map((l) => l.getAttribute('aria-label'))).toEqual(EN);
  });

  it('renders Hindi labels when mode is hi', () => {
    render(<TeacherShell mode="hi">page</TeacherShell>);
    const links = within(screen.getByRole('navigation')).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('aria-label'))).toEqual(HI);
  });

  it('shows English with Hindi under it in both mode', () => {
    render(<TeacherShell mode="both">page</TeacherShell>);
    const links = within(screen.getByRole('navigation')).getAllByRole('link');
    expect(links[0]).toHaveTextContent('Homeहोम');
  });

  it('links to the 5 teacher routes and marks the current slot', () => {
    render(<TeacherShell>page</TeacherShell>);
    const links = within(screen.getByRole('navigation')).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(PATHS);
    expect(links[1]).toHaveAttribute('aria-current', 'page');
    expect(links[0]).not.toHaveAttribute('aria-current');
  });

  it('renders the page content', () => {
    render(<TeacherShell>hello teacher</TeacherShell>);
    expect(screen.getByText('hello teacher')).toBeInTheDocument();
  });
});
