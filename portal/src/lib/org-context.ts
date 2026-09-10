import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { asOrgRole, type OrgRole } from "@/lib/roles";

export interface OrgContext {
  userId: string | null;
  orgId: string | null;
  role: OrgRole | null;
}

/**
 * Resolves the current user's id, active org id, and role in one place --
 * the direct replacement for the Clerk-era `const { userId, orgId, orgRole
 * } = await auth()`. `current_org_id()`/`current_org_role()`
 * (0002_rls.sql) are already granted to `authenticated` and do the actual
 * resolution (via organization_members/user_active_org) server-side in
 * Postgres -- this is a thin convenience wrapper, not new authorization
 * logic.
 *
 * Uses `getClaims()`, not `getUser()`/`getSession()`: current Supabase
 * guidance (checked live against their docs while building this) is that
 * `getClaims()` is the right call for authorization decisions -- it
 * validates the JWT signature locally on every call (as trustworthy as
 * `getUser()`, without that function's extra Auth-server round-trip), while
 * `getSession()`'s embedded user object is explicitly documented as
 * untrustworthy for this purpose (unverified, just whatever's in the
 * client-controllable cookie).
 *
 * Returns nulls rather than throwing when there's no session / no active
 * org / no membership -- every caller must treat that as "no access",
 * never throw, never assume (same convention the old Clerk-era roles.ts
 * used).
 */
export async function getOrgContext(
  supabase: SupabaseClient,
): Promise<OrgContext> {
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return { userId: null, orgId: null, role: null };
  }

  const [{ data: orgId }, { data: role }] = await Promise.all([
    supabase.rpc("current_org_id"),
    supabase.rpc("current_org_role"),
  ]);

  return {
    userId: claims.sub,
    orgId: (orgId as string | null) ?? null,
    role: asOrgRole(role as string | null),
  };
}

/** Just the current user's id/email claims, for pages that don't need org context (e.g. onboarding, before an active org exists). */
export async function getCurrentUserClaims(supabase: SupabaseClient) {
  const { data } = await supabase.auth.getClaims();
  return data?.claims ?? null;
}

export type { OrgRole };
