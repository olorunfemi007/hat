export const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

/** Destination rows contain references to credentials, never the credentials. */
export interface StorageDestination {
  org_id?: string;
  provider: string;
  bucket: string;
  region: string | null;
  endpoint: string | null;
  credentials_secret_ref: string;
}

export interface UploadCapture {
  capture_id: string;
  object_key: string;
  content_type: string;
  byte_size: number;
  sha256: string;
}

export interface CaptureMetadata extends UploadCapture {
  device_id: string;
  site_id: string | null;
  captured_at: string;
  kind: string;
  metadata: Record<string, unknown>;
}

export interface UploadInstruction {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expires_at: string;
}

/** Only these messages may cross the machine API / portal boundary. */
export class StorageError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 503,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export function publicStorageError(error: unknown): StorageError {
  return error instanceof StorageError
    ? error
    : new StorageError("storage_unavailable", "Storage is unavailable. Check the connection and try again.");
}
