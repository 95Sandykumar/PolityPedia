/**
 * Sign-in page (issue 03-sign-in).
 * Outside the (student) group on purpose: no bottom nav before sign-in.
 * Env is read here, on the server, inside the render, so the build needs no
 * environment variables.
 */
import { SignInForm } from '@/components/sign-in-form';
import { createSupabaseAuthClient } from '@/lib/auth/supabase-auth-client';

export const metadata = { title: 'Sign in | PolityPedia' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const configured = createSupabaseAuthClient().isConfigured();
  // The Google callback sends ?error=denied|no_code|expired|failed|not_configured
  // (issue 64-signin-errors-and-resend). The form ignores any other value.
  const { error } = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col justify-center px-4 py-6">
      <SignInForm
        configured={configured}
        initialError={typeof error === 'string' ? error : undefined}
      />
    </main>
  );
}
