"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/org-context";
import { canManageDevices } from "@/lib/roles";
import type { ActionResult } from "../sites/actions";

/**
 * Updates a device's display_name and/or site_id. This is deliberately the
 * ONLY device write this app exposes via plain UPDATE -- it's also the only
 * one Postgres allows: `grant update (display_name, site_id) on
 * public.devices to authenticated` (0002_rls.sql). org_id, status, and
 * both credential hashes are not writable this way at all, by design.
 */
export async function updateDevice(
  deviceId: string,
  formData: FormData,
): Promise<ActionResult> {
  const supabase = await createServerSupabaseClient();
  const { orgId, role } = await getOrgContext(supabase);
  if (!orgId) {
    return { ok: false, error: "No active organization." };
  }
  if (!canManageDevices(role)) {
    return {
      ok: false,
      error: "You don't have permission to manage devices.",
    };
  }

  const displayName = String(formData.get("display_name") ?? "").trim();
  const siteId = String(formData.get("site_id") ?? "");

  const { error } = await supabase
    .from("devices")
    .update({
      display_name: displayName || null,
      site_id: siteId || null,
    })
    .eq("id", deviceId);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/devices");
  return { ok: true };
}
