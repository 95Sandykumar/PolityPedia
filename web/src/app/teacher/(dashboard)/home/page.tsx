/**
 * Teacher Home (issue 03-sign-in, moved into the dashboard shell by issue
 * 07-next-exam-date-teacher-shell).
 *
 * Thin on purpose: the real dashboard content belongs to later issues. The
 * shell around it comes from `(dashboard)/layout.tsx`.
 */
import { PlaceholderPage } from '@/components/placeholder-page';

export default function TeacherHomePage() {
  return <PlaceholderPage titleKey="nav.home" />;
}
