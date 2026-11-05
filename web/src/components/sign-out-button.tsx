/**
 * Me > Sign out (issue 33-session-refresh).
 *
 * A PLAIN FORM POST, not a fetch. These phones are on 4G that drops, and a
 * student handing the phone back has to be able to sign out even when the page
 * JavaScript never arrived. The route answers 303, so the browser lands on
 * /sign-in with a GET and Back does not re-post.
 *
 * DESIGN.md: 48 px touch target (section 5), 1 px border, no shadow, radius
 * 10 px (section 2), tokens only. Not red: red is for a destructive Delete,
 * and signing out destroys nothing (section 3).
 */
import { LogOut } from 'lucide-react';
import { SIGN_OUT_PATH } from '@/lib/auth/browser-auth-client';
import { labels, type LangMode } from '@/lib/i18n';

export function SignOutButton({ mode }: { mode: LangMode }) {
  return (
    <form action={SIGN_OUT_PATH} method="post">
      <button
        type="submit"
        className="inline-flex min-h-12 w-full items-center justify-between gap-2 rounded-[10px] border border-border bg-card px-3 text-base font-medium text-foreground transition-colors duration-100"
      >
        <span>
          {labels('me.signOut', mode).map((line, index) => (
            <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
              {line}
            </span>
          ))}
        </span>
        <LogOut aria-hidden="true" className="size-5 text-muted-foreground" />
      </button>
    </form>
  );
}
