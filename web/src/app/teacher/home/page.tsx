/**
 * Teacher home (issue 03-sign-in).
 * Thin on purpose: this slice only proves the role guard. The real dashboard
 * belongs to a later issue. Middleware sends a student here to Home.
 */
import { PlaceholderPage } from '@/components/placeholder-page';

export default function TeacherHomePage() {
  return (
    <main className="mx-auto w-full max-w-[1120px] px-4 py-4">
      <PlaceholderPage titleKey="nav.teacherHome" />
    </main>
  );
}
