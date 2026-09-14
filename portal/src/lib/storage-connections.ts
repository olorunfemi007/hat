import "server-only";

export interface StorageConnectionChoice {
  reference: string;
  label: string;
  provider: "s3" | "minio";
  buckets: string[];
  endpoints: string[];
}

/** Only safe display fields belonging to this organization may reach the browser. */
export function storageConnectionChoices(orgId: string): StorageConnectionChoice[] {
  let entries: unknown;
  try { entries = JSON.parse(process.env.HARDHAT_STORAGE_CREDENTIALS ?? "{}"); }
  catch { return []; }
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return [];
  return Object.entries(entries).flatMap(([reference, value]) => {
    if (!value || typeof value !== "object" || value.org_id !== orgId ||
      !["s3", "minio"].includes(value.provider) || !Array.isArray(value.allowed_buckets)) return [];
    return [{
      reference, label: typeof value.label === "string" ? value.label : reference,
      provider: value.provider,
      buckets: value.allowed_buckets.filter((v: unknown): v is string => typeof v === "string"),
      endpoints: Array.isArray(value.allowed_endpoints)
        ? value.allowed_endpoints.filter((v: unknown): v is string => typeof v === "string") : [],
    }];
  });
}
