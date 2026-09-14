import type { SupabaseClient } from "@supabase/supabase-js";
import type { StorageDestination, UploadCapture, UploadInstruction, CaptureMetadata } from "../../../../lib/storage/types";
import { StorageError, publicStorageError } from "../../../../lib/storage/types";
import { readSyncRequest } from "./protocol";

interface CaptureRow extends CaptureMetadata {
  org_id: string;
  storage_config_id: string;
  status: string;
  verified_at: string | null;
}
interface SyncDependencies {
  createAdmin: () => SupabaseClient;
  prepareUpload: (config: StorageDestination, capture: UploadCapture, orgId: string, admin: SupabaseClient) => Promise<UploadInstruction>;
  verifyUpload: (config: StorageDestination, capture: UploadCapture, orgId: string, admin: SupabaseClient) => Promise<{ provider_version: string | null }>;
  persistCaptureMetadata: (config: StorageDestination, capture: CaptureMetadata, orgId: string, providerVersion: string | null, admin: SupabaseClient) => Promise<void>;
}

function reply(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
function receipt(capture: CaptureRow) {
  if (!capture.verified_at) throw new StorageError("receipt_unavailable", "The verified receipt is unavailable. Try again.");
  return {
    capture_id: capture.capture_id, state: "verified",
    receipt: { capture_id: capture.capture_id, sha256: capture.sha256, byte_size: capture.byte_size, verified_at: capture.verified_at },
  };
}
function first<T>(data: unknown): T | undefined { return Array.isArray(data) ? data[0] as T | undefined : undefined; }
function databaseError(error: { code?: string; message?: string } | null): never {
  // Map known database outcomes, never expose Postgres messages or arguments.
  if (error?.code === "42501") throw new StorageError("device_unauthorized", "Device uploads are no longer authorized.", 401);
  if (error?.code === "22023" && error.message?.includes("capture not found")) {
    throw new StorageError("capture_not_found", "The capture has not been registered for this device.", 404);
  }
  if (error?.code === "22023") throw new StorageError("invalid_request", "The sync request contains invalid capture information.", 400);
  if (error?.code === "23505" || error?.message?.includes("capture_conflict")) {
    throw new StorageError("capture_conflict", "This capture ID is already registered with different information.", 409);
  }
  if (error?.message?.includes("storage") || error?.message?.includes("destination")) {
    throw new StorageError("storage_not_ready", "An organization administrator must connect and verify an active storage destination.", 409);
  }
  throw new StorageError("sync_unavailable", "Capture sync is unavailable. Try again.");
}

/** Injected boundaries keep authentication, tenancy and retry behavior testable without real secrets. */
export function createSyncHandler(deps: SyncDependencies) {
  return async function POST(request: Request) {
    let admin: SupabaseClient | undefined;
    let deviceId: string | undefined;
    let activeCaptureId: string | undefined;
    try {
      const body = await readSyncRequest(request);
      admin = deps.createAdmin();
      const authentication = await admin.rpc("authenticate_upload_device", {
        p_serial_number: body.device.serial_number,
        p_hardware_serial: body.device.hardware_serial,
        p_device_identity_secret: body.device.device_identity_secret,
      });
      if (authentication.error) databaseError(authentication.error);
      const device = first<{ device_id: string; org_id: string; site_id: string | null }>(authentication.data);
      if (!device?.device_id || !device.org_id) throw new StorageError("device_unauthorized", "Device authentication or organization assignment is required.", 401);
      deviceId = device.device_id;
      if (body.stats) {
        const status = await admin.rpc("report_device_sync_status", {
          p_device_id: deviceId, p_queued_count: body.stats.queued_count, p_queued_bytes: body.stats.queued_bytes,
          // Do not persist arbitrary device text (it may include URLs or credentials).
          p_last_error: body.stats.last_error ? "The device reports a local capture or upload problem." : null,
        });
        if (status.error) databaseError(status.error);
      }
      if (body.action === "status") return reply({ ok: true });

      let capture: CaptureRow | undefined;
      if (body.action === "prepare") {
        const input = body.capture!;
        const reservation = await admin.rpc("reserve_capture", {
          p_device_id: deviceId, p_capture_id: input.capture_id, p_captured_at: input.captured_at,
          p_kind: input.kind, p_content_type: input.content_type, p_byte_size: input.byte_size,
          p_sha256: input.sha256, p_metadata: input.metadata,
        });
        if (reservation.error) databaseError(reservation.error);
        capture = first<CaptureRow>(reservation.data);
      } else {
        const result = await admin.from("captures").select("*")
          .eq("capture_id", body.capture_id!).eq("device_id", deviceId).eq("org_id", device.org_id).maybeSingle();
        if (result.error) databaseError(result.error);
        capture = result.data as CaptureRow | undefined;
      }
      if (!capture || capture.device_id !== deviceId || capture.org_id !== device.org_id) {
        throw new StorageError("capture_not_found", "The capture has not been registered for this device.", 404);
      }
      activeCaptureId = capture.capture_id;
      if (capture.status === "verified") return reply(receipt(capture));

      const destination = await admin.from("storage_configs").select("*")
        .eq("id", capture.storage_config_id).eq("org_id", device.org_id).is("disabled_at", null).not("verified_at", "is", null).maybeSingle();
      if (destination.error) databaseError(destination.error);
      if (!destination.data) throw new StorageError("storage_not_ready", "The assigned storage connection needs administrator attention.", 409);
      const config = destination.data as StorageDestination;

      if (body.action === "prepare") {
        // The pinned row must be authorized again immediately before minting a URL.
        const start = await admin.rpc("begin_capture_upload", { p_device_id: deviceId, p_capture_id: capture.capture_id });
        if (start.error) databaseError(start.error);
        const current = first<CaptureRow>(start.data);
        if (!current) throw new StorageError("capture_not_found", "The capture is no longer available to this device.", 404);
        if (current.status === "verified") return reply(receipt(current));
        const upload = await deps.prepareUpload(config, current, device.org_id, admin);
        return reply({ capture_id: current.capture_id, state: "uploading", upload });
      }

      const verified = await deps.verifyUpload(config, capture, device.org_id, admin);
      await deps.persistCaptureMetadata(config, capture, device.org_id, verified.provider_version, admin);
      const completion = await admin.rpc("verify_capture_receipt", {
        p_device_id: deviceId, p_capture_id: capture.capture_id, p_provider_version: verified.provider_version,
      });
      if (completion.error) databaseError(completion.error);
      const completed = first<CaptureRow>(completion.data);
      if (!completed || completed.status !== "verified") throw new StorageError("receipt_unavailable", "The upload could not be confirmed. Try again.");
      return reply(receipt(completed));
    } catch (error) {
      const safe = publicStorageError(error);
      if (admin && deviceId && activeCaptureId) {
        // Reporting must never obscure the original failure or downgrade a verified capture.
        try { await admin.rpc("fail_capture_upload", {
          p_device_id: deviceId, p_capture_id: activeCaptureId, p_last_error: safe.message,
        }); } catch { /* The device will report its queue again on its next sync. */ }
      }
      return reply({ error: safe.code, message: safe.message }, safe.status);
    }
  };
}
