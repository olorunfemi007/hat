"use client";

import { useActionState } from "react";
import { deleteStorageConfig } from "./actions";
import type { ActionResult } from "../sites/actions";
import type { StorageConfig } from "@/lib/supabase/types";

const initialState: ActionResult = { ok: true };

const PROVIDER_LABELS: Record<StorageConfig["provider"], string> = {
  s3: "Amazon S3",
  azure_blob: "Azure Blob Storage",
  gcs: "Google Cloud Storage",
  minio: "MinIO",
};

export function StorageConfigRow({ config }: { config: StorageConfig }) {
  const [state, action, pending] = useActionState(
    async () => deleteStorageConfig(config.id),
    initialState,
  );

  return (
    <li className="flex flex-col gap-1 py-3">
      <div className="flex flex-wrap items-center justify-between">
        <div>
          <p className="text-sm font-medium">
            {PROVIDER_LABELS[config.provider]} · {config.bucket}
          </p>
          <p className="text-xs text-neutral-500">
            {[config.region, config.endpoint].filter(Boolean).join(" · ") ||
              "No region/endpoint set"}
          </p>
          <p className="mt-0.5 font-mono text-xs text-neutral-400">
            secret ref: {config.credentials_secret_ref}
          </p>
        </div>
        <form action={action}>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md border border-red-300 px-3 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
          >
            {pending ? "Removing…" : "Remove"}
          </button>
        </form>
      </div>
      {!state.ok && state.error && (
        <p className="text-xs text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
    </li>
  );
}
