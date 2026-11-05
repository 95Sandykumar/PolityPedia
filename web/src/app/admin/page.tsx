/**
 * Admin home (issue 03-sign-in).
 * Thin on purpose: this slice only proves the role guard.
 */
import { PlaceholderPage } from '@/components/placeholder-page';

export default function AdminPage() {
  return (
    <main className="mx-auto w-full max-w-[1120px] px-4 py-4">
      <PlaceholderPage titleKey="nav.adminHome" />
    </main>
  );
}
