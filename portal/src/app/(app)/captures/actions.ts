"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/org-context";
import { canManageDevices } from "@/lib/roles";
import type { ActionResult } from "../sites/actions";

export async function setDeviceUploads(deviceId: string, enabled: boolean): Promise<ActionResult> {
  const supabase = await createServerSupabaseClient();
  const { role } = await getOrgContext(supabase);
  if (!canManageDevices(role)) return { ok: false, error: "You do not have permission to manage device uploads." };
  const { error } = await supabase.rpc("set_device_upload_enabled", { p_device_id: deviceId, p_enabled: enabled });
  if (error) return { ok: false, error: "Could not change upload access for this device." };
  revalidatePath("/captures");
  return { ok: true };
}
