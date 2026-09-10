"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/org-context";
import { canManageStorage } from "@/lib/roles";
import type { ActionResult } from "../sites/actions";
import type { StorageProvider } from "@/lib/supabase/types";

const PROVIDERS: StorageProvider[] = ["s3", "azure_blob", "gcs", "minio"];

type OrgAdminGuard =
  | { ok: true; orgId: string }
  | { ok: false; error: string };

async function requireOrgAdmin(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
): Promise<OrgAdminGuard> {
  const { orgId, role } = await getOrgContext(supabase);
  if (!orgId) return { ok: false, error: "No active organization." };
  if (!canManageStorage(role)) {
    return {
      ok: false,
      error: "Only org admins can manage storage configuration.",
    };
  }
  return { ok: true, orgId };
}

export async function createStorageConfig(
  formData: FormData,
): Promise<ActionResult> {
  const supabase = await createServerSupabaseClient();
  const guard = await requireOrgAdmin(supabase);
  if (!guard.ok) return guard;

  const provider = String(formData.get("provider") ?? "");
  const bucket = String(formData.get("bucket") ?? "").trim();
  const region = String(formData.get("region") ?? "").trim();
  const endpoint = String(formData.get("endpoint") ?? "").trim();
  const credentialsSecretRef = String(
    formData.get("credentials_secret_ref") ?? "",
  ).trim();

  if (!PROVIDERS.includes(provider as StorageProvider)) {
    return { ok: false, error: "Choose a valid storage provider." };
  }
  if (!bucket || !credentialsSecretRef) {
    return {
      ok: false,
      error: "Bucket and credentials secret reference are required.",
    };
  }

  const { error } = await supabase.from("storage_configs").insert({
    org_id: guard.orgId,
    provider,
    bucket,
    region: region || null,
    endpoint: endpoint || null,
    credentials_secret_ref: credentialsSecretRef,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/storage");
  return { ok: true };
}

export async function deleteStorageConfig(id: string): Promise<ActionResult> {
  const supabase = await createServerSupabaseClient();
  const guard = await requireOrgAdmin(supabase);
  if (!guard.ok) return guard;

  const { error } = await supabase
    .from("storage_configs")
    .delete()
    .eq("id", id);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/storage");
  return { ok: true };
}
