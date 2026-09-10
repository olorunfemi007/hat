"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { getOrgContext } from "@/lib/org-context";
import { canRenameOrg, canManageMembers, ORG_ROLES, type OrgRole } from "@/lib/roles";
import type { ActionResult } from "../sites/actions";
import type { InviteMemberResult } from "@/lib/supabase/types";

function siteUrl(): string {
  const url = process.env.NEXT_PUBLIC_SITE_URL;
  if (!url) {
    throw new Error("NEXT_PUBLIC_SITE_URL must be set -- see .env.example.");
  }
  return url;
}

/**
 * Renames the portal's own copy of the org name (organizations.name). This
 * is the org's real, only name now -- there's no external Clerk org to stay
 * in sync with any more (see 0001_schema.sql's header).
 */
export async function renamePortalOrgName(
  formData: FormData,
): Promise<ActionResult> {
  const supabase = await createServerSupabaseClient();
  const { orgId, role } = await getOrgContext(supabase);
  if (!orgId) {
    return { ok: false, error: "No active organization." };
  }
  if (!canRenameOrg(role)) {
    return { ok: false, error: "Only org admins can rename the organization." };
  }

  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    return { ok: false, error: "Name is required." };
  }

  const { error } = await supabase
    .from("organizations")
    .update({ name })
    .eq("id", orgId);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/", "layout");
  return { ok: true };
}

function isOrgRole(value: string): value is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(value);
}

/**
 * Invites someone by email. Two steps, matching supabase/README.md's
 * documented split: (1) invite_member() (0007) decides server-side, based
 * on real membership/role facts, whether this adds an existing account
 * immediately or records a pending invite; (2) ONLY when it returns
 * outcome='invited' do we call the Auth Admin API (service-role client,
 * server-side only, never exposed to the browser) to actually send the
 * invite email. Calling inviteUserByEmail() unconditionally (or before
 * checking the outcome) would be wrong: for the 'added_existing_member'
 * case that account already exists, so the Admin API would just error
 * "user already registered" for no reason invite_member() didn't already
 * decide on its own.
 */
export async function inviteMember(
  formData: FormData,
): Promise<ActionResult> {
  const supabase = await createServerSupabaseClient();
  const { orgId, role } = await getOrgContext(supabase);
  if (!orgId) {
    return { ok: false, error: "No active organization." };
  }
  if (!canManageMembers(role)) {
    return { ok: false, error: "Only org admins can invite members." };
  }

  const email = String(formData.get("email") ?? "").trim();
  const roleInput = String(formData.get("role") ?? "");

  if (!email) {
    return { ok: false, error: "Email is required." };
  }
  if (!isOrgRole(roleInput)) {
    return { ok: false, error: "Choose a valid role." };
  }

  const { data, error } = await supabase.rpc("invite_member", {
    p_org_id: orgId,
    p_email: email,
    p_role: roleInput,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  const result = (Array.isArray(data) ? data[0] : data) as
    | InviteMemberResult
    | undefined;

  if (result?.outcome === "invited") {
    const admin = createAdminSupabaseClient();
    const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(
      email,
      { redirectTo: `${siteUrl()}/auth/confirm?next=/dashboard` },
    );
    if (inviteError) {
      // The Postgres-side invite record still exists (invite_member()
      // already committed it) -- this is a delivery failure, not a state
      // rollback. Report it plainly rather than pretending it succeeded;
      // the org_admin can see the pending invite in the list either way
      // and could ask the person to sign up directly, which the signup
      // trigger (0008) will still resolve into a real membership.
      return {
        ok: false,
        error: `Recorded the invite, but the invite email failed to send: ${inviteError.message}`,
      };
    }
  }

  revalidatePath("/org");
  return { ok: true };
}

export async function revokeInvite(inviteId: string): Promise<ActionResult> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("revoke_invite", {
    p_invite_id: inviteId,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/org");
  return { ok: true };
}

export async function changeMemberRole(
  userId: string,
  newRole: string,
): Promise<ActionResult> {
  const supabase = await createServerSupabaseClient();
  const { orgId } = await getOrgContext(supabase);
  if (!orgId) {
    return { ok: false, error: "No active organization." };
  }
  if (!isOrgRole(newRole)) {
    return { ok: false, error: "Choose a valid role." };
  }

  const { error } = await supabase.rpc("change_member_role", {
    p_org_id: orgId,
    p_user_id: userId,
    p_new_role: newRole,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/org");
  return { ok: true };
}

export async function removeMember(userId: string): Promise<ActionResult> {
  const supabase = await createServerSupabaseClient();
  const { orgId } = await getOrgContext(supabase);
  if (!orgId) {
    return { ok: false, error: "No active organization." };
  }

  const { error } = await supabase.rpc("remove_member", {
    p_org_id: orgId,
    p_user_id: userId,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/org");
  return { ok: true };
}
