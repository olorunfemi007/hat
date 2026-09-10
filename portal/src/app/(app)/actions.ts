"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * Switches the caller's active org. set_active_org() (0007) verifies real
 * membership server-side before writing -- this action never trusts orgId
 * beyond passing it through. Redirects to /dashboard rather than just
 * revalidating, since every page under (app)/ implicitly depends on
 * current_org_id() and a hard navigation is the simplest way to guarantee
 * every Server Component re-reads it fresh.
 */
export async function switchActiveOrg(orgId: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_active_org", { p_org_id: orgId });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
  redirect("/dashboard");
}
