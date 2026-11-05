/**
 * Tile page `/t/<teacherId>/mocks` (issue 06-portfolio-follow).
 *
 * A real page with a real URL, so the portfolio tile has somewhere to go and
 * back works (DESIGN.md section 7). The CONTENT is issue 10; this slice only
 * wires the tile up, so it shows the title plus "Coming soon".
 *
 * The title is in the student's saved language, like every other label.
 */
import { PlaceholderPage } from '@/components/placeholder-page';
import { readStudentContext } from '@/lib/follows/student-page';

export default async function TeacherMocksPage() {
  const { mode } = await readStudentContext();
  return <PlaceholderPage titleKey="tile.mocks" mode={mode} />;
}
