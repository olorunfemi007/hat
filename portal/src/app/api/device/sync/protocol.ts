import { MAX_CAPTURE_BYTES, StorageError } from "../../../../lib/storage/types";

const MAX_BODY_BYTES = 24 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MIME_TYPES: Record<string, string[]> = {
  video: ["video/mp4", "video/h264", "video/x-matroska", "video/webm"],
  audio: ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/flac"],
  image: ["image/jpeg", "image/png"],
  sensor: ["application/json", "application/x-ndjson", "text/csv"],
};

export interface CaptureInput {
  capture_id: string;
  captured_at: string;
  kind: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  metadata: Record<string, unknown>;
}

export interface SyncRequest {
  action: "prepare" | "complete" | "status";
  device: { serial_number: string; hardware_serial: string; device_identity_secret: string };
  capture?: CaptureInput;
  capture_id?: string;
  stats?: { queued_count: number; queued_bytes: number; last_error?: string | null };
}

function invalid(): never { throw new StorageError("invalid_request", "The sync request is invalid.", 400); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
}
function safeMetadata(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 2048 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
  if (Array.isArray(value)) return value.length <= 128 && value.every((item) => safeMetadata(item, depth + 1));
  if (!record(value)) return false;
  return Object.entries(value).every(([key, item]) => /^[a-zA-Z0-9_.-]{1,64}$/.test(key) &&
    !["__proto__", "prototype", "constructor"].includes(key) && safeMetadata(item, depth + 1));
}

export function validateSyncRequest(value: unknown): SyncRequest {
  if (!record(value) || !["prepare", "complete", "status"].includes(value.action as string) || !record(value.device)) return invalid();
  const device = value.device;
  if (!text(device.serial_number, 128) || !text(device.hardware_serial, 128) || !text(device.device_identity_secret, 512)) return invalid();
  if (value.action === "prepare") {
    const capture = value.capture;
    if (!record(capture) || typeof capture.capture_id !== "string" || !UUID.test(capture.capture_id) ||
        !text(capture.captured_at, 64) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(capture.captured_at) ||
        !Number.isFinite(Date.parse(capture.captured_at)) || typeof capture.kind !== "string" ||
        !Object.hasOwn(MIME_TYPES, capture.kind) || !MIME_TYPES[capture.kind].includes(capture.content_type as string) ||
        !Number.isSafeInteger(capture.byte_size) || (capture.byte_size as number) < 1 || (capture.byte_size as number) > MAX_CAPTURE_BYTES ||
        typeof capture.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(capture.sha256)) return invalid();
    if (capture.metadata === undefined) capture.metadata = {};
    if (!record(capture.metadata) || !safeMetadata(capture.metadata) || Buffer.byteLength(JSON.stringify(capture.metadata), "utf8") > 8192) return invalid();
  }
  if (value.action === "complete" && (typeof value.capture_id !== "string" || !UUID.test(value.capture_id))) return invalid();
  if (value.stats !== undefined) {
    if (!record(value.stats) || !Number.isSafeInteger(value.stats.queued_count) || (value.stats.queued_count as number) < 0 ||
        (value.stats.queued_count as number) > 1_000_000 || !Number.isSafeInteger(value.stats.queued_bytes) ||
        (value.stats.queued_bytes as number) < 0 || (value.stats.queued_bytes as number) > 1_000_000_000_000 ||
        (value.stats.last_error != null && (typeof value.stats.last_error !== "string" || value.stats.last_error.length > 512))) return invalid();
  }
  return value as unknown as SyncRequest;
}

export async function readSyncRequest(request: Request): Promise<SyncRequest> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new StorageError("unsupported_media_type", "Send the sync request as application/json.", 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) {
    throw new StorageError("request_too_large", "The sync request exceeds the size limit.", 413);
  }
  if (!request.body) return invalid();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new StorageError("request_timeout", "The sync request timed out.", 408)), 10_000);
  });
  try {
    for (;;) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_BODY_BYTES) throw new StorageError("request_too_large", "The sync request exceeds the size limit.", 413);
      chunks.push(result.value);
    }
  } finally {
    clearTimeout(timeout);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return invalid(); }
  return validateSyncRequest(parsed);
}
