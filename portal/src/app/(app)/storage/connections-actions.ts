"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { getOrgContext } from "@/lib/org-context";
import { canManageStorage } from "@/lib/roles";
import { ROLE_ARN_PATTERN } from "@/lib/storage/policy";
import { assertPublicEndpoint } from "@/lib/storage/ssrf";
import { encryptStorageSecret } from "@/lib/storage/crypto";
import { testCandidateConnection, publicStorageError } from "@/lib/storage";
import type { ActionResult } from "../sites/actions";
import type { StorageCredential } from "@/lib/storage/policy";
import type { StorageDestination } from "@/lib/storage/types";

// The RPCs (0015_storage_connections.sql) always store a ciphertext row per
// connection, even for role-based AWS auth, which has no secret at all --
// the security boundary there is the customer's own IAM trust policy, not
// anything this portal holds. This constant fills that column with
// something meaningful-but-not-secret rather than an arbitrary placeholder,
// still run through the same encryption path as a real MinIO/S3 key so
// storage_connection_secrets never has to distinguish "real ciphertext" from
// "there was nothing to encrypt" at the column level.
const NO_SECRET_PLACEHOLDER = "role-based-auth-uses-iam-trust-policy-not-a-stored-secret";

function defaultS3Endpoint(region: string): string {
  return `https://s3.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;
}

async function adminContext() {
  const supabase = await createServerSupabaseClient();
  const { orgId, role } = await getOrgContext(supabase);
  if (!orgId || !canManageStorage(role)) return null;
  return { supabase, orgId };
}
const denied = (): ActionResult => ({ ok: false, error: "Only organization admins can manage storage." });

function validName(formData: FormData): string | null {
  const name = String(formData.get("name") ?? "").trim();
  return name && name.length <= 120 ? name : null;
}
function validBucket(formData: FormData): string | null {
  const bucket = String(formData.get("bucket") ?? "").trim();
  return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) && !bucket.includes("..") && !/^\d+\.\d+\.\d+\.\d+$/.test(bucket) ? bucket : null;
}
function validRegion(formData: FormData): string | null {
  const region = String(formData.get("region") ?? "").trim();
  return /^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region) ? region : null;
}

export interface BeginAwsConnectionResult extends ActionResult {
  connectionId?: string;
  externalId?: string;
}

/** Step 1 of the AWS flow: reserve a connection, generate and return its external_id for the customer's IAM trust policy. */
export async function beginAwsStorageConnection(formData: FormData): Promise<BeginAwsConnectionResult> {
  const ctx = await adminContext();
  if (!ctx) return denied();
  const name = validName(formData);
  const bucket = validBucket(formData);
  const region = validRegion(formData);
  if (!name) return { ok: false, error: "Enter a destination name of up to 120 characters." };
  if (!bucket) return { ok: false, error: "Enter a valid S3 bucket name." };
  if (!region) return { ok: false, error: "Enter a valid AWS region, e.g. us-east-1." };

  const { userId } = await getOrgContext(ctx.supabase);
  if (!userId) return denied();
  const connectionId = randomUUID();
  const { data, error } = await createAdminSupabaseClient().rpc("begin_storage_connection", {
    p_actor: userId, p_org: ctx.orgId, p_id: connectionId, p_details: { name, bucket, region },
  });
  if (error || typeof data !== "string") return { ok: false, error: "Could not start this connection. Try again." };
  revalidatePath("/storage");
  return { ok: true, connectionId, externalId: data };
}

/** Step 2 of the AWS flow: the customer has created their IAM role. Real-verify AssumeRole + bucket access before saving anything. */
export async function saveAwsStorageConnection(formData: FormData): Promise<ActionResult> {
  const ctx = await adminContext();
  if (!ctx) return denied();
  const { userId } = await getOrgContext(ctx.supabase);
  if (!userId) return denied();

  const connectionId = String(formData.get("connection_id") ?? "");
  const revision = Number(formData.get("revision"));
  const roleArn = String(formData.get("role_arn") ?? "").trim();
  const makeDefault = formData.get("make_default") === "on";
  if (!connectionId || !Number.isInteger(revision) || revision < 0) return { ok: false, error: "Reload the connection setup and try again." };
  if (!ROLE_ARN_PATTERN.test(roleArn)) return { ok: false, error: "Enter a valid IAM role ARN, e.g. arn:aws:iam::123456789012:role/HardhatUpload." };

  // Never trust the form for bucket/region/external_id/name -- read the
  // server's own record of what THIS connection is (RLS already scopes
  // this to the caller's own org via storage_connections_admin_read).
  const { data: existing, error: fetchError } = await ctx.supabase.from("storage_connections")
    .select("id, name, bucket, region, external_id, status")
    .eq("id", connectionId).maybeSingle();
  if (fetchError || !existing || existing.status === "disconnected") return { ok: false, error: "This connection setup was not found. Start a new one." };
  if (!existing.external_id) return { ok: false, error: "This connection has no pending setup to complete." };

  const entry: StorageCredential = {
    org_id: ctx.orgId, provider: "s3", allowed_buckets: [existing.bucket],
    role_arn: roleArn, external_id: existing.external_id, use_default_credentials: true,
  };
  const endpoint = defaultS3Endpoint(existing.region);
  const config: StorageDestination = {
    org_id: ctx.orgId, provider: "s3", bucket: existing.bucket, region: existing.region,
    endpoint: null, credentials_secret_ref: "candidate",
  };
  try {
    await testCandidateConnection(entry, existing.region, endpoint, config, ctx.orgId);
  } catch (error) {
    return { ok: false, error: publicStorageError(error).message };
  }

  const placeholder = encryptStorageSecret(NO_SECRET_PLACEHOLDER);
  const admin = createAdminSupabaseClient();
  const { error } = await admin.rpc("save_storage_connection", {
    p_actor: userId, p_org: ctx.orgId, p_id: connectionId, p_revision: revision,
    p_details: { provider: "s3", bucket: existing.bucket, region: existing.region, auth_mode: "role", name: existing.name, role_arn: roleArn },
    p_key_id: placeholder.keyId, p_ciphertext: placeholder.ciphertext, p_make_default: makeDefault,
  });
  if (error) {
    return { ok: false, error: error.code === "40001" ? "This connection changed elsewhere. Reload and try again." : "Could not save this connection." };
  }
  revalidatePath("/storage");
  return { ok: true };
}

/** MinIO/self-hosted S3: one-shot, no external_id/IAM round trip -- real-verify the static key before saving it, encrypted. */
export async function connectMinioStorage(formData: FormData): Promise<ActionResult> {
  const ctx = await adminContext();
  if (!ctx) return denied();
  const { userId } = await getOrgContext(ctx.supabase);
  if (!userId) return denied();

  const name = validName(formData);
  const bucket = validBucket(formData);
  const region = validRegion(formData) ?? "us-east-1";
  const endpoint = String(formData.get("endpoint") ?? "").trim();
  const accessKeyId = String(formData.get("access_key_id") ?? "").trim();
  const secretAccessKey = String(formData.get("secret_access_key") ?? "");
  if (!name) return { ok: false, error: "Enter a destination name of up to 120 characters." };
  if (!bucket) return { ok: false, error: "Enter a valid bucket name." };
  if (!accessKeyId || !secretAccessKey) return { ok: false, error: "Enter both the access key and secret key." };
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
    if (endpointUrl.protocol !== "https:" && !(endpointUrl.protocol === "http:" && process.env.HARDHAT_ALLOW_INSECURE_STORAGE === "true")) {
      return { ok: false, error: "The endpoint must use HTTPS." };
    }
  } catch {
    return { ok: false, error: "Enter a valid endpoint URL, e.g. https://minio.example.com." };
  }
  try {
    await assertPublicEndpoint(endpointUrl.origin);
  } catch (error) {
    return { ok: false, error: publicStorageError(error).message };
  }

  const entry: StorageCredential = {
    org_id: ctx.orgId, provider: "minio", allowed_buckets: [bucket],
    access_key_id: accessKeyId, secret_access_key: secretAccessKey,
  };
  const config: StorageDestination = {
    org_id: ctx.orgId, provider: "minio", bucket, region,
    endpoint: endpointUrl.origin, credentials_secret_ref: "candidate",
  };
  try {
    await testCandidateConnection(entry, region, endpointUrl.origin, config, ctx.orgId);
  } catch (error) {
    return { ok: false, error: publicStorageError(error).message };
  }

  const secret = encryptStorageSecret(`${accessKeyId}\n${secretAccessKey}`);
  const admin = createAdminSupabaseClient();
  const { error } = await admin.rpc("save_storage_connection", {
    p_actor: userId, p_org: ctx.orgId, p_id: randomUUID(), p_revision: 0,
    p_details: { provider: "minio", bucket, region, endpoint: endpointUrl.origin, auth_mode: "keys", name },
    p_key_id: secret.keyId, p_ciphertext: secret.ciphertext, p_make_default: formData.get("make_default") === "on",
  });
  if (error) return { ok: false, error: "Could not save this connection. Check the endpoint and bucket." };
  revalidatePath("/storage");
  return { ok: true };
}

export async function disconnectStorageConnection(connectionId: string, revision: number): Promise<ActionResult> {
  const ctx = await adminContext();
  if (!ctx) return denied();
  const { userId } = await getOrgContext(ctx.supabase);
  if (!userId) return denied();
  const { error } = await createAdminSupabaseClient().rpc("disconnect_storage_connection", {
    p_actor: userId, p_org: ctx.orgId, p_id: connectionId, p_revision: revision,
  });
  if (error) return { ok: false, error: error.code === "40001" ? "This connection changed elsewhere. Reload and try again." : "Could not disconnect this connection." };
  revalidatePath("/storage");
  return { ok: true };
}
