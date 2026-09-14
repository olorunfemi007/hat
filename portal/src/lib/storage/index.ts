import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { pinnedStorageHandler } from "./ssrf";
import { verifyAwsRoleTrust } from "./aws-role";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { resolveStoragePolicy, type StorageCredential } from "./policy";
import {
  MAX_CAPTURE_BYTES, StorageError, publicStorageError,
  type StorageDestination, type UploadCapture, type UploadInstruction, type CaptureMetadata,
} from "./types";

export { StorageError, publicStorageError } from "./types";
export type { StorageDestination, UploadCapture, UploadInstruction, CaptureMetadata } from "./types";

const UPLOAD_TTL_SECONDS = 300;
const CLOUD_TIMEOUT_MS = 30_000;

/**
 * Pure client construction from an already-resolved credential entry --
 * split out from resolveStoragePolicy's lookup/validation so a NOT-YET-SAVED
 * candidate connection (built in memory from a "Connect storage" form
 * submission, before any storage_connections row exists) can be
 * real-verified through the exact same S3Client construction and the exact
 * same put/verify/conditional-write/delete test as an already-saved
 * connection -- see testCandidateConnection below. Never export this
 * without also exporting a way to validate `entry` first: it does no
 * validation of its own by design, matching the split every other function
 * in this module already has (resolveStoragePolicy validates, clientFor/this
 * only builds).
 */
async function buildS3Client(entry: StorageCredential, region: string, endpoint: string, pinEndpoint = false): Promise<S3Client> {
  const staticCredentials = entry.access_key_id && entry.secret_access_key ? {
    accessKeyId: entry.access_key_id,
    secretAccessKey: entry.secret_access_key,
    sessionToken: entry.session_token,
  } : undefined;
  const credentials = entry.role_arn ? fromTemporaryCredentials({
    masterCredentials: staticCredentials,
    clientConfig: { region },
    params: { RoleArn: entry.role_arn, ExternalId: entry.external_id, RoleSessionName: "hardhat-capture-sync" },
  }) : staticCredentials;
  return new S3Client({
    region, endpoint, credentials, forcePathStyle: true,
    // Never follow a provider redirect to an endpoint outside the operator's policy.
    followRegionRedirects: false,
    maxAttempts: 2,
    requestHandler: pinEndpoint ? await pinnedStorageHandler(endpoint) : { connectionTimeout: 5_000, requestTimeout: CLOUD_TIMEOUT_MS },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

async function clientFor(config: StorageDestination, orgId: string, admin: SupabaseClient) {
  const { entry, endpoint, region } = await resolveStoragePolicy(config, orgId, admin);
  return buildS3Client(entry, region, endpoint, config.credentials_secret_ref.startsWith("connection:") && entry.provider === "minio");
}

function validateCapture(capture: UploadCapture) {
  if (!Number.isSafeInteger(capture.byte_size) || capture.byte_size < 1 || capture.byte_size > MAX_CAPTURE_BYTES ||
      !/^[a-f0-9]{64}$/.test(capture.sha256) || !capture.object_key || capture.object_key.length > 1024 ||
      capture.object_key.split("/").some((part) => part === ".." || part === ".") ||
      /[\x00-\x1f\x7f]/.test(capture.object_key)) {
    throw new StorageError("invalid_capture", "Capture information is invalid.", 400);
  }
}

function providerError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const cloud = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  if (cloud?.$metadata?.httpStatusCode === 404 || cloud?.name === "NoSuchKey" || cloud?.name === "NotFound") {
    return new StorageError("upload_incomplete", "The capture has not reached storage yet. Retry the upload.", 409);
  }
  if (cloud?.$metadata?.httpStatusCode === 403 || cloud?.name === "AccessDenied") {
    return new StorageError("storage_permission_denied", "Storage permissions need attention. Check the connected account.");
  }
  return publicStorageError(error);
}

function uploadCommand(config: StorageDestination, capture: UploadCapture, body?: Uint8Array) {
  return new PutObjectCommand({
    Bucket: config.bucket, Key: capture.object_key, ContentType: capture.content_type,
    ContentLength: capture.byte_size, ChecksumSHA256: Buffer.from(capture.sha256, "hex").toString("base64"),
    IfNoneMatch: "*", Body: body,
  });
}

export async function prepareUpload(
  config: StorageDestination, capture: UploadCapture, orgId: string, admin: SupabaseClient,
): Promise<UploadInstruction> {
  validateCapture(capture);
  const client = await clientFor(config, orgId, admin);
  try {
    const url = await getSignedUrl(client, uploadCommand(config, capture), {
      expiresIn: UPLOAD_TTL_SECONDS,
      unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
      signableHeaders: new Set(["content-type", "content-length", "if-none-match"]),
    });
    return {
      url, method: "PUT",
      headers: {
        "content-type": capture.content_type,
        "content-length": String(capture.byte_size),
        "x-amz-checksum-sha256": Buffer.from(capture.sha256, "hex").toString("base64"),
        "if-none-match": "*",
      },
      expires_at: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString(),
    };
  } catch (error) { throw providerError(error); }
  finally { client.destroy(); }
}

function mismatch(): never {
  throw new StorageError("capture_integrity_mismatch", "The stored capture does not match its recorded size or checksum. The local copy must be retained.", 409);
}

async function verifyWithClient(client: S3Client, config: StorageDestination, capture: UploadCapture) {
  const signal = AbortSignal.timeout(CLOUD_TIMEOUT_MS);
  const head = await client.send(new HeadObjectCommand({
    Bucket: config.bucket, Key: capture.object_key, ChecksumMode: "ENABLED",
  }), { abortSignal: signal });
  if (head.ContentLength !== capture.byte_size) return mismatch();
  // ChecksumSHA256 is validated by S3 during upload. User-supplied object metadata is never evidence.
  if (head.ChecksumSHA256 && head.ChecksumType !== "COMPOSITE") {
    if (head.ChecksumSHA256 !== Buffer.from(capture.sha256, "hex").toString("base64")) return mismatch();
  } else {
    // Compatible providers may omit SHA256. Read exactly the expected object version,
    // hash the actual bytes, and bound both transfer size and time.
    const object = await client.send(new GetObjectCommand({
      Bucket: config.bucket, Key: capture.object_key,
      VersionId: head.VersionId, IfMatch: head.ETag,
    }), { abortSignal: signal });
    if (!object.Body) return mismatch();
    const body = object.Body as AsyncIterable<Uint8Array> & { destroy?: () => void };
    let count = 0;
    const hash = createHash("sha256");
    try {
      for await (const chunk of body) {
        count += chunk.byteLength;
        if (count > capture.byte_size || count > MAX_CAPTURE_BYTES) return mismatch();
        hash.update(chunk);
      }
    } finally { body.destroy?.(); }
    if (count !== capture.byte_size || hash.digest("hex") !== capture.sha256) return mismatch();
  }
  return { provider_version: head.VersionId ?? head.ETag ?? null };
}

export async function verifyUpload(config: StorageDestination, capture: UploadCapture, orgId: string, admin: SupabaseClient) {
  validateCapture(capture);
  const client = await clientFor(config, orgId, admin);
  try { return await verifyWithClient(client, config, capture); }
  catch (error) { throw providerError(error); }
  finally { client.destroy(); }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Portable manifest travels with the data, independently of the portal database. */
export async function persistCaptureMetadata(
  config: StorageDestination, capture: CaptureMetadata, orgId: string, providerVersion: string | null, admin: SupabaseClient,
) {
  validateCapture(capture);
  const data = Buffer.from(canonicalJson({
    schema_version: 1, capture_id: capture.capture_id, device_id: capture.device_id,
    site_id: capture.site_id, captured_at: capture.captured_at, kind: capture.kind,
    content_type: capture.content_type, byte_size: capture.byte_size, sha256: capture.sha256,
    object_key: capture.object_key, provider_version: providerVersion, metadata: capture.metadata,
  }) + "\n", "utf8");
  if (data.length > 16 * 1024) throw new StorageError("invalid_metadata", "Capture metadata exceeds the size limit.", 400);
  const sidecar: UploadCapture = {
    capture_id: capture.capture_id, object_key: `${capture.object_key}.metadata.json`,
    content_type: "application/json", byte_size: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
  const client = await clientFor(config, orgId, admin);
  try {
    try {
      await client.send(uploadCommand(config, sidecar, data), { abortSignal: AbortSignal.timeout(CLOUD_TIMEOUT_MS) });
    } catch (error) {
      // A previous request may have written the sidecar before losing its response.
      if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode !== 412) throw error;
    }
    await verifyWithClient(client, config, sidecar);
  } catch (error) { throw providerError(error); }
  finally { client.destroy(); }
}

/** This probe touches only a fresh, unguessable test object; never a customer capture. */
async function runConnectionTest(client: S3Client, config: StorageDestination, orgId: string): Promise<{ verified_at: string }> {
  const data = randomBytes(128);
  const capture: UploadCapture = {
    capture_id: randomUUID(), object_key: `${orgId}/.hardhat-tests/${randomUUID()}`,
    content_type: "application/octet-stream", byte_size: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
  let created = false;
  let versionId: string | undefined;
  try {
    const written = await client.send(uploadCommand(config, capture, data), { abortSignal: AbortSignal.timeout(CLOUD_TIMEOUT_MS) });
    created = true;
    versionId = written.VersionId;
    await verifyWithClient(client, config, capture);
    // Require provider support for create-only writes before activating a connection.
    let overwriteDenied = false;
    try { await client.send(uploadCommand(config, capture, data), { abortSignal: AbortSignal.timeout(CLOUD_TIMEOUT_MS) }); }
    catch (error) { if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 412) overwriteDenied = true; else throw error; }
    if (!overwriteDenied) throw new StorageError("unsafe_storage_provider", "Storage must support conditional writes to protect verified captures.", 422);
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: capture.object_key, VersionId: versionId }), {
      abortSignal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
    });
    created = false;
    return { verified_at: new Date().toISOString() };
  } catch (error) { throw providerError(error); }
  finally {
    if (created) {
      try { await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: capture.object_key, VersionId: versionId }), {
        abortSignal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
      }); } catch { /* Original safe error describes the failing connection. */ }
    }
  }
}

export async function testStorageConnection(config: StorageDestination, orgId: string, admin: SupabaseClient): Promise<{ verified_at: string }> {
  const client = await clientFor(config, orgId, admin);
  try { return await runConnectionTest(client, config, orgId); }
  finally { client.destroy(); }
}

/**
 * Real-verifies a connection BEFORE it's ever saved: an org_admin's
 * "Connect storage" submission (AWS role_arn+external_id after they've
 * created the IAM role, or MinIO/S3 static keys) is proven to actually
 * work -- real AssumeRole, real put+verify+conditional-write+delete against
 * the real bucket -- before save_storage_connection() ever marks it
 * connected. `entry`/`region`/`endpoint` must already be validated by the
 * caller (role_arn shape, SSRF-safe endpoint, etc.) -- this function only
 * builds a client and runs the same real test testStorageConnection() runs
 * for an already-saved connection.
 */
export async function testCandidateConnection(
  entry: StorageCredential, region: string, endpoint: string, config: StorageDestination, orgId: string,
): Promise<{ verified_at: string }> {
  if (entry.role_arn) {
    if (!entry.external_id) throw new StorageError("invalid_role", "An external ID is required.", 422);
    const temporary = await verifyAwsRoleTrust(entry.role_arn, entry.external_id, region);
    entry = { ...entry, ...temporary, role_arn: undefined };
  }
  const client = await buildS3Client(entry, region, endpoint, entry.provider === "minio");
  try { return await runConnectionTest(client, config, orgId); }
  finally { client.destroy(); }
}
