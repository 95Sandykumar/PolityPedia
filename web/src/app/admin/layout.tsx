/**
 * The admin shell (admin-ui pass): a menu that shows where you are, and the
 * page beside it.
 *
 * Phone: the menu is a tab strip stuck to the top, scrolling sideways inside
 * itself. Laptop (1024 and up): a sticky left sidebar. Every page under
 * `/admin` renders its own `<main>`; the shell adds none, so there is one
 * landmark per page. The middleware already keeps non-admins out (issue 03).
 *
 * Source: hand-built from DESIGN.md tokens.
 */
import { AdminNav } from '@/components/admin-nav';
import { SignOutButton } from '@/components/sign-out-button';
import { DEFAULT_MODE } from '@/lib/i18n';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const mode = DEFAULT_MODE;
  return (
    <div className="mx-auto w-full max-w-[1120px] px-4 lg:grid lg:grid-cols-[208px_minmax(0,1fr)] lg:gap-6">
      <div className="sticky top-0 z-10 -mx-4 bg-background px-4 lg:mx-0 lg:self-start lg:px-0">
        <AdminNav mode={mode} />
        <div className="hidden pt-3 lg:block">
          <SignOutButton mode={mode} />
        </div>
      </div>
      <div className="min-w-0">
        {children}
        <div className="pt-2 pb-6 lg:hidden">
          <SignOutButton mode={mode} />
        </div>
      </div>
    </div>
  );
}
