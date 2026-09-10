"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export interface CreateOrgState {
  ok: boolean;
  error?: string;
}

export async function createOrganization(
  _prev: CreateOrgState,
  formData: FormData,
): Promise<CreateOrgState> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    return { ok: false, error: "Organization name is required." };
  }

  const supabase = await createServerSupabaseClient();
  // create_organization() (0007_org_management_functions.sql) atomically
  // creates the org, makes the caller its org_admin, and sets it as their
  // active org -- no separate steps needed here.
  const { error } = await supabase.rpc("create_organization", {
    p_name: name,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  redirect("/dashboard");
}
