import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptStorageSecret } from "./crypto";
import { StorageError, type StorageDestination } from "./types";

export interface StorageCredential {
  org_id: string;
  provider: "s3" | "minio";
  allowed_buckets: string[];
  allowed_endpoints?: string[];
  access_key_id?: string;
  secret_access_key?: string;
  session_token?: string;
  role_arn?: string;
  external_id?: string;
  use_default_credentials?: boolean;
}

function invalidConnection(): never {
  throw new StorageError("storage_not_configured", "Storage connection is not configured for this organization.");
}

function endpointOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { return invalidConnection(); }
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && process.env.HARDHAT_ALLOW_INSECURE_STORAGE === "true")) ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/"
  ) return invalidConnection();
  return url.origin;
}

export const ROLE_ARN_PATTERN = /^arn:aws(?:-cn|-us-gov)?:iam::\d{12}:role\/[\w+=,.@/-]+$/;

function validateBucketRegion(config: StorageDestination) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) || config.bucket.includes("..") || /^\d+\.\d+\.\d+\.\d+$/.test(config.bucket)) return invalidConnection();
  const region = config.region || "us-east-1";
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) return invalidConnection();
  return region;
}

interface ConnectionRow {
  id: string; org_id: string; provider: string; bucket: string; region: string;
  endpoint: string | null; auth_mode: "role" | "keys"; role_arn: string | null;
  external_id: string | null; status: string;
}
interface ConnectionSecretRow { key_id: string; ciphertext: string }

/**
 * A GUI-managed connection (storage_connections + storage_connection_secrets,
 * see 0015_storage_connections.sql), resolved fresh on every call rather than
 * cached -- disconnecting a connection must take effect on the very next
 * request, not whenever some cache happens to expire.
 */
async function resolveConnection(config: StorageDestination, orgId: string, admin: SupabaseClient) {
  const connectionId = config.credentials_secret_ref.slice("connection:".length);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectionId)) return invalidConnection();
  const { data: connection, error } = await admin.from("storage_connections").select("*")
    .eq("id", connectionId).eq("org_id", orgId).eq("status", "connected").maybeSingle();
  if (error || !connection) return invalidConnection();
  const row = connection as ConnectionRow;
  if (row.provider !== config.provider || row.bucket !== config.bucket) return invalidConnection();

  const entry: StorageCredential = { org_id: orgId, provider: row.provider as "s3" | "minio", allowed_buckets: [row.bucket] };
  if (row.auth_mode === "role") {
    if (row.provider !== "s3" || !row.role_arn || !row.external_id || !ROLE_ARN_PATTERN.test(row.role_arn)) return invalidConnection();
    entry.role_arn = row.role_arn;
    entry.external_id = row.external_id;
    entry.use_default_credentials = true;
  } else {
    const { data: secretRow, error: secretError } = await admin.from("storage_connection_secrets")
      .select("key_id, ciphertext").eq("connection_id", row.id).eq("org_id", orgId).maybeSingle();
    if (secretError || !secretRow) return invalidConnection();
    const secret = secretRow as ConnectionSecretRow;
    let accessKeyId: string, secretAccessKey: string;
    try {
      [accessKeyId, secretAccessKey] = decryptStorageSecret(secret.key_id, secret.ciphertext).split("\n");
    } catch { return invalidConnection(); }
    if (!accessKeyId || !secretAccessKey) return invalidConnection();
    entry.access_key_id = accessKeyId;
    entry.secret_access_key = secretAccessKey;
  }
  const region = validateBucketRegion(config);
  const endpoint = row.endpoint ? endpointOrigin(row.endpoint)
    : row.provider === "minio" ? invalidConnection()
    : `https://s3.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;
  return { entry, region, endpoint };
}

/** Both bucket and endpoint are approved by the operator, outside tenant-editable rows. */
async function resolveEnvPolicy(config: StorageDestination, orgId: string) {
  let credentials: Record<string, StorageCredential>;
  try { credentials = JSON.parse(process.env.HARDHAT_STORAGE_CREDENTIALS ?? "{}"); } catch { return invalidConnection(); }
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials) ||
      !Object.hasOwn(credentials, config.credentials_secret_ref)) return invalidConnection();
  const entry = credentials[config.credentials_secret_ref];
  if (!entry || entry.org_id !== orgId || entry.provider !== config.provider ||
      !Array.isArray(entry.allowed_buckets) || !entry.allowed_buckets.includes(config.bucket)) return invalidConnection();
  const region = validateBucketRegion(config);
  let endpoint: string;
  if (config.endpoint) {
    endpoint = endpointOrigin(config.endpoint);
    if (!Array.isArray(entry.allowed_endpoints) || !entry.allowed_endpoints.some((allowed) => typeof allowed === "string" && endpointOrigin(allowed) === endpoint)) return invalidConnection();
  } else {
    if (config.provider === "minio") return invalidConnection();
    endpoint = `https://s3.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;
  }
  const hasStatic = typeof entry.access_key_id === "string" && entry.access_key_id.length > 0 &&
    typeof entry.secret_access_key === "string" && entry.secret_access_key.length > 0;
  if ((entry.access_key_id || entry.secret_access_key) && !hasStatic) return invalidConnection();
  if (entry.role_arn && (config.provider !== "s3" || !ROLE_ARN_PATTERN.test(entry.role_arn) || !entry.external_id)) return invalidConnection();
  if (!hasStatic && !entry.role_arn && entry.use_default_credentials !== true) return invalidConnection();
  if (config.provider === "minio" && !hasStatic) return invalidConnection();
  return { entry, region, endpoint };
}

/**
 * Resolves a storage destination to its actual credential, from whichever of
 * the two coexisting sources credentials_secret_ref points at: the
 * operator-managed HARDHAT_STORAGE_CREDENTIALS env var (unchanged, original
 * behavior), or a "connection:<uuid>" reference into the GUI-managed
 * storage_connections/storage_connection_secrets tables (0015). `admin` is
 * required for the latter (storage_connection_secrets is service_role-only,
 * by design -- see 0015_storage_connections.sql) but unused for the former.
 */
export async function resolveStoragePolicy(config: StorageDestination, orgId: string, admin: SupabaseClient) {
  if (config.provider !== "s3" && config.provider !== "minio") {
    throw new StorageError("unsupported_provider", "Automatic capture sync currently supports Amazon S3 and MinIO.", 422);
  }
  if (!orgId || (config.org_id !== undefined && config.org_id !== orgId)) return invalidConnection();
  return config.credentials_secret_ref.startsWith("connection:")
    ? resolveConnection(config, orgId, admin)
    : resolveEnvPolicy(config, orgId);
}
