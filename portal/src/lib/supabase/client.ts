"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * Client Component Supabase client, authenticated via the native Supabase
 * Auth session (browser reads/writes the same session cookies the server
 * client and `src/proxy.ts` use). `@supabase/ssr`'s `createBrowserClient`
 * uses a singleton internally, so calling this multiple times is cheap.
 *
 * This app is built primarily around Server Components + Server Actions, so
 * most pages won't need this -- it's here for any Client Component that
 * needs to query Supabase directly (e.g. live/optimistic UI). Prefer Server
 * Actions for anything that writes data.
 */
export function createBrowserSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set -- see .env.example.",
    );
  }

  return createBrowserClient(supabaseUrl, supabaseKey);
}
