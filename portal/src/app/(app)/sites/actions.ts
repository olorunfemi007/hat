"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/org-context";
import { canManageSites } from "@/lib/roles";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

type SiteManagerGuard = { ok: true; orgId: string } | { ok: false; error: string };

/**
 * Every action below re-checks role in app code before touching Supabase.
 * This is UX only (a faster, friendlier error than a raw Postgres
 * permission-denied) -- the `sites_*_own_org_managers` RLS policies in
 * 0002_rls.sql are the actual, authoritative gate and will reject these
 * writes regardless of what this file does.
 */
async function requireSiteManagerRole(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
): Promise<SiteManagerGuard> {
  const { orgId, role } = await getOrgContext(supabase);
  if (!orgId) {
    return { ok: false, error: "No active organization." };
  }
  if (!canManageSites(role)) {
    return {
      ok: false,
      error: "You don't have permission to manage sites.",
    };
  }
  return { ok: true, orgId };
}

export async function createSite(formData: FormData): Promise<ActionResult> {
  const supabase = await createServerSupabaseClient();
  const guard = await requireSiteManagerRole(supabase);
  if (!guard.ok) return guard;

  const name = String(formData.get("name") ?? "").trim();
  const address = String(formData.get("address") ?? "").trim();

  if (!name) {
    return { ok: false, error: "Site name is required." };
  }

  const { error } = await supabase
    .from("sites")
    .insert({ name, address: address || null, org_id: guard.orgId });

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/sites");
  return { ok: true };
}

export async function renameSite(
  siteId: string,
  formData: FormData,
): Promise<ActionResult> {
  const supabase = await createServerSupabaseClient();
  const guard = await requireSiteManagerRole(supabase);
  if (!guard.ok) return guard;

  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    return { ok: false, error: "Site name is required." };
  }

  const { error } = await supabase
    .from("sites")
    .update({ name })
    .eq("id", siteId);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/sites");
  return { ok: true };
}

export async function deleteSite(siteId: string): Promise<ActionResult> {
  const supabase = await createServerSupabaseClient();
  const guard = await requireSiteManagerRole(supabase);
  if (!guard.ok) return guard;

  const { error } = await supabase.from("sites").delete().eq("id", siteId);

  if (error) {
    // Most likely cause: devices_site_org_fk `on delete restrict` -- a site
    // with devices still assigned to it can't be deleted. Give a useful
    // message rather than the raw Postgres FK-violation text.
    return {
      ok: false,
      error: error.message.includes("foreign key")
        ? "This site still has devices assigned to it. Reassign or unassign them first."
        : error.message,
    };
  }

  revalidatePath("/sites");
  return { ok: true };
}
