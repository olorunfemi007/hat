"use client";

import { useActionState } from "react";
import { createStorageConfig } from "./actions";
import type { ActionResult } from "../sites/actions";

const initialState: ActionResult = { ok: true };

export function StorageConfigForm() {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionResult, formData: FormData) =>
      createStorageConfig(formData),
    initialState,
  );

  return (
    <form
      action={formAction}
      className="space-y-4 rounded-lg border border-neutral-200 p-6 dark:border-neutral-800"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-xs font-medium text-neutral-500">
            Provider
            <select
              name="provider"
              required
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            >
              <option value="s3">Amazon S3</option>
              <option value="azure_blob">Azure Blob Storage</option>
              <option value="gcs">Google Cloud Storage</option>
              <option value="minio">MinIO</option>
            </select>
          </label>
        </div>
        <div>
          <label className="block text-xs font-medium text-neutral-500">
            Bucket
            <input
              name="bucket"
              required
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              placeholder="hardhat-fleet-data"
            />
          </label>
        </div>
        <div>
          <label className="block text-xs font-medium text-neutral-500">
            Region (optional)
            <input
              name="region"
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              placeholder="us-east-1"
            />
          </label>
        </div>
        <div>
          <label className="block text-xs font-medium text-neutral-500">
            Endpoint (optional)
            <input
              name="endpoint"
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              placeholder="Only needed for S3-compatible / MinIO endpoints"
            />
          </label>
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-neutral-500">
          Credentials secret reference
          <input
            name="credentials_secret_ref"
            required
            className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm font-mono dark:border-neutral-700 dark:bg-neutral-900"
            placeholder="e.g. vault:hardhat/storage/acme-prod"
          />
        </label>
        <p className="mt-1 text-xs text-neutral-500">
          This is a <strong>reference/name</strong> pointing at a secret held
          in Supabase Vault (or your equivalent secrets store) -- never enter
          an actual access key or credential value here. This app has no UI
          for raw credentials by design; whatever manages your secrets store
          is where the referenced secret actually gets created.
        </p>
      </div>

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        {pending ? "Adding…" : "Add storage config"}
      </button>
      {!state.ok && state.error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
    </form>
  );
}
