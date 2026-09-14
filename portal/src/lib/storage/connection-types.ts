/** Safe metadata only. Never add credential/ciphertext fields to these DTOs. */
export interface StorageConnection {
  id: string;
  name: string;
  provider: "s3" | "minio";
  bucket: string;
  region: string;
  endpoint: string | null;
  auth_mode: "role" | "keys";
  role_arn: string | null;
  external_id: string | null;
  status: "pending" | "connected" | "disconnected" | "cancelled";
  revision: number;
  config_id: string | null;
}
export interface StorageConnectionEvent {
  id: string; connection_id: string; actor_id: string | null; event: string; created_at: string;
}
export const CONNECTION_FIELDS = "id,name,provider,bucket,region,endpoint,auth_mode,role_arn,external_id,status,revision,config_id";
