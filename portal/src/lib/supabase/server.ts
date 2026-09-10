import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Server-side Supabase client for Server Components / Server Actions / Route
 * Handlers, authenticated as the current user via a native Supabase Auth
 * session (cookie-based) -- not a third-party JWT bridge (that was the
 * Clerk-era design; see supabase/README.md's Sep 2026 note on why Clerk was
 * dropped).
 *
 * `@supabase/ssr`'s `createServerClient` is the current officially
 * recommended approach for exactly this case. The Clerk-era version of this
 * file specifically avoided `@supabase/ssr` because its `createServerClient`
 * calls `supabase.auth.onAuthStateChange()` internally, which throws when
 * configured with the `accessToken` callback option that third-party-auth
 * mode requires (https://github.com/supabase/ssr/issues/103) -- that
 * limitation is specific to third-party-auth mode. Native Supabase Auth
 * doesn't use an `accessToken` callback at all (the session lives in
 * cookies, which this client reads/writes directly), so it's unaffected.
 *
 * The `setAll` call can fail here when called from a Server Component
 * (which cannot set cookies) -- that's expected and safe to ignore, since
 * `middleware.ts`'s (`src/proxy.ts`) session-refresh logic is what actually
 * keeps the session cookie current across requests.
 */
export async function createServerSupabaseClient() {
  const cookieStore = await cookies();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set -- see .env.example.",
    );
  }

  return createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component - cookies can't be set here.
          // Harmless as long as proxy.ts is refreshing the session.
        }
      },
    },
  });
}
