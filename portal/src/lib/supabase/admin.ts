import "server-only";

import { createClient } from "@supabase/supabase-js";

/**
 * service_role Supabase client. Bypasses RLS entirely -- see
 * supabase/README.md's "service_role needs explicit table grants" section.
 *
 * ONLY use this for `supabase.auth.admin.inviteUserByEmail()`, called from
 * the invite Server Action (src/app/(app)/org/actions.ts) after
 * `invite_member()` returns `outcome = 'invited'`. That Auth Admin API call
 * requires the service-role/secret key and is JS-SDK-only -- it can never
 * be expressed in SQL (see supabase/README.md's "Invites" section). This is
 * NOT used for organizations rows any more: those are created directly by
 * `create_organization()`, an ordinary `authenticated`-callable RPC, now
 * that there's no external Clerk event to sync (see 0001_schema.sql's
 * header). Never import this from a Client Component, never send
 * SUPABASE_SERVICE_ROLE_KEY to the browser, and never use this client to
 * serve a user-facing read/write path -- every other request in this app
 * must go through createServerSupabaseClient() so RLS actually applies.
 */
export function createAdminSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set -- see .env.example.",
    );
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
