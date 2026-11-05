/**
 * Tile page `/t/<teacherId>/papers` (issue 06-portfolio-follow).
 *
 * A real page with a real URL, so the portfolio tile has somewhere to go and
 * back works (DESIGN.md section 7). The CONTENT is issue 07; this slice only
 * wires the tile up, so it shows the title plus "Coming soon".
 *
 * The title is in the student's saved language, like every other label.
 */
import { PlaceholderPage } from '@/components/placeholder-page';
import { readStudentContext } from '@/lib/follows/student-page';

export default async function TeacherPapersPage() {
  const { mode } = await readStudentContext();
  return <PlaceholderPage titleKey="tile.papers" mode={mode} />;
}
