"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { getOrgContext } from "@/lib/org-context";
import { canManageStorage } from "@/lib/roles";
import { ROLE_ARN_PATTERN } from "@/lib/storage/policy";
import { storageEndpointOrigin } from "@/lib/storage/ssrf";
import { encryptStorageSecret } from "@/lib/storage/crypto";
import { testCandidateConnection, publicStorageError } from "@/lib/storage";
import { CONNECTION_FIELDS, type StorageConnection } from "@/lib/storage/connection-types";
import type { ActionResult } from "../sites/actions";
import type { StorageCredential } from "@/lib/storage/policy";
import type { StorageDestination } from "@/lib/storage/types";

async function adminContext() {
  const supabase = await createServerSupabaseClient();
  const { orgId, role, userId } = await getOrgContext(supabase);
  if (!orgId || !userId || !canManageStorage(role)) return null;
  return { supabase, orgId, userId };
}
const denied = (): ActionResult => ({ ok: false, error: "Only organization admins can manage storage." });
const changed = (): ActionResult => ({ ok: false, error: "This connection changed elsewhere. Reload and try again." });
const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const uuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
function revision(form: FormData) {
  const value = text(form, "revision");
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : -1;
}
function validDetails(name: string, bucket: string, region: string): string | null {
  if (!name || name.length > 120) return "Enter a destination name of up to 120 characters.";
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..") || /^\d+\.\d+\.\d+\.\d+$/.test(bucket)) return "Enter a valid bucket name.";
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) return "Enter a valid region, e.g. us-east-1.";
  return null;
}
async function connectionFor(ctx: NonNullable<Awaited<ReturnType<typeof adminContext>>>, id: string) {
  if (!uuid(id)) return null;
  const { data, error } = await ctx.supabase.from("storage_connections").select(CONNECTION_FIELDS)
    .eq("id", id).eq("org_id", ctx.orgId).maybeSingle<StorageConnection>();
  return error ? null : data;
}
function refreshStorage() { revalidatePath("/storage"); revalidatePath("/captures"); }

export interface BeginAwsConnectionResult extends ActionResult { connectionId?: string; externalId?: string }
export async function beginAwsStorageConnection(form: FormData): Promise<BeginAwsConnectionResult> {
  const ctx = await adminContext();
  if (!ctx) return denied();
  const name = text(form, "name"), bucket = text(form, "bucket"), region = text(form, "region");
  const error = validDetails(name, bucket, region);
  if (error) return { ok: false, error };
  const connectionId = randomUUID();
  const saved = await createAdminSupabaseClient().rpc("begin_storage_connection", {
    p_actor: ctx.userId, p_org: ctx.orgId, p_id: connectionId, p_details: { name, bucket, region },
  });
  if (saved.error || typeof saved.data !== "string") return { ok: false, error: "Could not start setup. Finish or cancel existing pending setups, then try again." };
  refreshStorage();
  return { ok: true, connectionId, externalId: saved.data };
}

export async function saveAwsStorageConnection(form: FormData): Promise<ActionResult> {
  const ctx = await adminContext();
  if (!ctx) return denied();
  const id = text(form, "connection_id"), expected = revision(form), roleArn = text(form, "role_arn");
  const existing = await connectionFor(ctx, id);
  if (!existing || existing.status === "cancelled" || existing.auth_mode !== "role" || !existing.external_id) return { ok: false, error: "AWS connection not found. Reload to see available setups." };
  if (expected !== existing.revision) return changed();
  if (!ROLE_ARN_PATTERN.test(roleArn)) return { ok: false, error: "Enter a valid IAM role ARN." };
  const entry: StorageCredential = { org_id: ctx.orgId, provider: "s3", allowed_buckets: [existing.bucket],
    role_arn: roleArn, external_id: existing.external_id, use_default_credentials: true };
  const config: StorageDestination = { org_id: ctx.orgId, provider: "s3", bucket: existing.bucket,
    region: existing.region, endpoint: null, credentials_secret_ref: "candidate" };
  try {
    // Check the server encryption configuration before making any cloud requests.
    const secret = encryptStorageSecret("role-auth-no-stored-cloud-secret");
    await testCandidateConnection(entry, existing.region,
      `https://s3.${existing.region}.amazonaws.com${existing.region.startsWith("cn-") ? ".cn" : ""}`, config, ctx.orgId);
    const saved = await createAdminSupabaseClient().rpc("save_storage_connection", {
      p_actor: ctx.userId, p_org: ctx.orgId, p_id: id, p_revision: expected,
      p_details: { provider: "s3", bucket: existing.bucket, region: existing.region, auth_mode: "role", name: existing.name, role_arn: roleArn },
      p_key_id: secret.keyId, p_ciphertext: secret.ciphertext, p_make_default: form.get("make_default") === "on",
    });
    if (saved.error) return saved.error.code === "40001" ? changed() : { ok: false, error: "Could not save the connection. Reload and try again." };
  } catch (error) { return { ok: false, error: publicStorageError(error).message }; }
  refreshStorage();
  return { ok: true };
}

/** New connection or credential replacement. Existing destination coordinates
 * come exclusively from the RLS-authorized row, preserving pending captures. */
export async function connectMinioStorage(form: FormData): Promise<ActionResult> {
  const ctx = await adminContext();
  if (!ctx) return denied();
  const id = text(form, "connection_id");
  const existing = id ? await connectionFor(ctx, id) : null;
  if (id && (!existing || existing.provider !== "minio" || existing.auth_mode !== "keys" || existing.status === "cancelled")) return { ok: false, error: "MinIO connection not found." };
  if (existing && revision(form) !== existing.revision) return changed();
  const name = existing?.name ?? text(form, "name"), bucket = existing?.bucket ?? text(form, "bucket");
  const region = existing?.region ?? (text(form, "region") || "us-east-1");
  const invalid = validDetails(name, bucket, region);
  if (invalid) return { ok: false, error: invalid };
  const accessKeyId = text(form, "access_key_id"), secretAccessKey = String(form.get("secret_access_key") ?? "");
  if (!accessKeyId || !secretAccessKey || accessKeyId.length > 256 || secretAccessKey.length > 4096 || /[\r\n]/.test(accessKeyId + secretAccessKey)) {
    return { ok: false, error: "Enter a valid access key and secret key without line breaks." };
  }
  try {
    const endpoint = storageEndpointOrigin(existing?.endpoint ?? text(form, "endpoint"));
    const secret = encryptStorageSecret(`${accessKeyId}\n${secretAccessKey}`);
    const entry: StorageCredential = { org_id: ctx.orgId, provider: "minio", allowed_buckets: [bucket], access_key_id: accessKeyId, secret_access_key: secretAccessKey };
    const config: StorageDestination = { org_id: ctx.orgId, provider: "minio", bucket, region, endpoint, credentials_secret_ref: "candidate" };
    await testCandidateConnection(entry, region, endpoint, config, ctx.orgId);
    const saved = await createAdminSupabaseClient().rpc("save_storage_connection", {
      p_actor: ctx.userId, p_org: ctx.orgId, p_id: existing?.id ?? randomUUID(), p_revision: existing?.revision ?? 0,
      p_details: { provider: "minio", bucket, region, endpoint, auth_mode: "keys", name },
      p_key_id: secret.keyId, p_ciphertext: secret.ciphertext, p_make_default: form.get("make_default") === "on",
    });
    if (saved.error) return saved.error.code === "40001" ? changed() : { ok: false, error: "Could not save the connection. Reload and try again." };
  } catch (error) { return { ok: false, error: publicStorageError(error).message }; }
  refreshStorage();
  return { ok: true };
}

export async function disconnectStorageConnection(id: string, expected: number): Promise<ActionResult> {
  const ctx = await adminContext();
  if (!ctx) return denied();
  const connection = await connectionFor(ctx, id);
  if (!connection || connection.status !== "connected") return { ok: false, error: "Connected storage account not found." };
  if (expected !== connection.revision) return changed();
  const { error } = await createAdminSupabaseClient().rpc("disconnect_storage_connection", {
    p_actor: ctx.userId, p_org: ctx.orgId, p_id: id, p_revision: expected,
  });
  if (error) return error.code === "40001" ? changed() : { ok: false, error: "Could not disconnect this connection." };
  refreshStorage();
  return { ok: true };
}

export async function cancelStorageConnection(id: string, expected: number): Promise<ActionResult> {
  const ctx = await adminContext();
  if (!ctx) return denied();
  if (!uuid(id) || !Number.isSafeInteger(expected) || expected < 0) return changed();
  const { error } = await createAdminSupabaseClient().rpc("cancel_storage_connection", {
    p_actor: ctx.userId, p_org: ctx.orgId, p_id: id, p_revision: expected,
  });
  if (error) return error.code === "40001" ? changed() : { ok: false, error: "Could not cancel setup. Reload to see its current status." };
  refreshStorage();
  return { ok: true };
}
