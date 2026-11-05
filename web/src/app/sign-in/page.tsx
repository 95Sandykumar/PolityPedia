/**
 * Sign-in page (issue 03-sign-in).
 * Outside the (student) group on purpose: no bottom nav before sign-in.
 * Env is read here, on the server, inside the render, so the build needs no
 * environment variables.
 */
import { SignInForm } from '@/components/sign-in-form';
import { createSupabaseAuthClient } from '@/lib/auth/supabase-auth-client';

export const metadata = { title: 'Sign in | PolityPedia' };

export default function SignInPage() {
  const configured = createSupabaseAuthClient().isConfigured();
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col justify-center px-4 py-6">
      <SignInForm configured={configured} />
    </main>
  );
}
