"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { getOrgContext } from "@/lib/org-context";
import { canManageStorage } from "@/lib/roles";
import { resolveStoragePolicy } from "@/lib/storage/policy";
import { testStorageConnection, publicStorageError } from "@/lib/storage";
import type { ActionResult } from "../sites/actions";
import type { StorageConfig } from "@/lib/supabase/types";

async function adminContext() {
  const supabase = await createServerSupabaseClient();
  const { orgId, role } = await getOrgContext(supabase);
  if (!orgId || !canManageStorage(role)) return null;
  return { supabase, orgId };
}
const denied = (): ActionResult => ({ ok: false, error: "Only organization admins can manage storage." });

export async function createStorageConfig(formData: FormData): Promise<ActionResult> {
  const ctx = await adminContext();
  if (!ctx) return denied();
  const config = {
    org_id: ctx.orgId,
    name: String(formData.get("name") ?? "").trim(),
    provider: String(formData.get("provider") ?? ""),
    bucket: String(formData.get("bucket") ?? "").trim(),
    region: String(formData.get("region") ?? "").trim() || null,
    endpoint: String(formData.get("endpoint") ?? "").trim() || null,
    credentials_secret_ref: String(formData.get("credentials_secret_ref") ?? "").trim(),
  };
  if (!config.name || config.name.length > 120) return { ok: false, error: "Enter a destination name of up to 120 characters." };
  try { await resolveStoragePolicy(config, ctx.orgId, createAdminSupabaseClient()); }
  catch (error) { return { ok: false, error: publicStorageError(error).message }; }
  const { error } = await ctx.supabase.from("storage_configs").insert(config);
  if (error) return { ok: false, error: "Could not save this destination. Check the selected account and bucket." };
  revalidatePath("/storage");
  return { ok: true };
}

export async function testStorageConfig(id: string): Promise<ActionResult> {
  const ctx = await adminContext();
  if (!ctx) return denied();
  // RLS first: possessing a configuration ID never grants access to its secrets.
  const { data: config, error } = await ctx.supabase.from("storage_configs").select("*")
    .eq("id", id).eq("org_id", ctx.orgId).maybeSingle<StorageConfig>();
  if (error || !config) return { ok: false, error: "Storage destination not found." };
  if (config.disabled_at) return { ok: false, error: "Resume this destination before testing it." };
  let verifiedAt: string | null = null;
  let failure: string | null = null;
  try { verifiedAt = (await testStorageConnection(config, ctx.orgId, createAdminSupabaseClient())).verified_at; }
  catch (cause) { failure = publicStorageError(cause).message; }

  // Only the trusted server may certify delivery. Compare the exact snapshot
  // tested so a concurrent destination edit cannot inherit a successful test.
  let update = createAdminSupabaseClient().from("storage_configs")
    .update({ verified_at: verifiedAt, verification_error: failure, ...(failure ? { is_default: false } : {}) })
    .eq("id", config.id).eq("org_id", ctx.orgId).eq("provider", config.provider)
    .eq("bucket", config.bucket).eq("credentials_secret_ref", config.credentials_secret_ref)
    .is("disabled_at", null);
  update = config.region === null ? update.is("region", null) : update.eq("region", config.region);
  update = config.endpoint === null ? update.is("endpoint", null) : update.eq("endpoint", config.endpoint);
  const saved = await update.select("id");
  revalidatePath("/storage");
  if (saved.error || saved.data?.length !== 1) return { ok: false, error: "The destination changed during the test. Test it again." };
  return failure ? { ok: false, error: failure } : { ok: true };
}

export async function setDefaultStorage(id: string): Promise<ActionResult> {
  const ctx = await adminContext();
  if (!ctx) return denied();
  const { error } = await ctx.supabase.rpc("set_default_storage", { p_config_id: id });
  if (error) return { ok: false, error: "Choose an enabled destination with a successful delivery test." };
  revalidatePath("/storage");
  return { ok: true };
}

export async function setStorageEnabled(id: string, enabled: boolean): Promise<ActionResult> {
  const ctx = await adminContext();
  if (!ctx) return denied();
  const { error } = await ctx.supabase.rpc("set_storage_enabled", { p_config_id: id, p_enabled: enabled });
  if (error) return { ok: false, error: "Could not update this destination." };
  revalidatePath("/storage");
  return { ok: true };
}

export async function setSiteStorage(siteId: string, configId: string | null): Promise<ActionResult> {
  const ctx = await adminContext();
  if (!ctx) return denied();
  const { error } = await ctx.supabase.rpc("set_site_storage", { p_site_id: siteId, p_config_id: configId });
  if (error) return { ok: false, error: "Choose an enabled, tested destination from this organization." };
  revalidatePath("/storage");
  return { ok: true };
}

export async function deleteStorageConfig(id: string): Promise<ActionResult> {
  const ctx = await adminContext();
  if (!ctx) return denied();
  const { error } = await ctx.supabase.from("storage_configs").delete().eq("id", id).eq("org_id", ctx.orgId);
  if (error) return { ok: false, error: error.code === "23503"
    ? "This destination has captures or site assignments. Pause it to stop uploads while keeping its history."
    : "Could not remove this destination." };
  revalidatePath("/storage");
  return { ok: true };
}
