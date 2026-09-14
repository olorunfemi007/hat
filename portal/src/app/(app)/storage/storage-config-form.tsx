"use client";

import { useActionState, useState } from "react";
import { createStorageConfig } from "./actions";
import type { ActionResult } from "../sites/actions";
import type { StorageConnectionChoice } from "@/lib/storage-connections";

const initialState: ActionResult = { ok: true };

export function StorageConfigForm({ connections }: { connections: StorageConnectionChoice[] }) {
  const [reference, setReference] = useState(connections[0]?.reference ?? "");
  const connection = connections.find((c) => c.reference === reference);
  const [state, action, pending] = useActionState(
    async (_prev: ActionResult, formData: FormData) => createStorageConfig(formData), initialState,
  );

  if (!connection) {
    return (
      <div className="surface p-6 space-y-2">
        <h2>Connect your storage account</h2>
        <p className="text-sm text-neutral-500">Your portal operator needs to connect your company&apos;s Amazon S3 or MinIO account first. Once connected, you can choose a bucket, test delivery, and start syncing your fleet.</p>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-5 surface p-6">
      <div><h2>Add a storage destination</h2><p className="text-sm text-neutral-500 mt-1">Choose a connected account and bucket. Test it before making it your fleet&apos;s default.</p></div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block text-xs font-medium text-neutral-500">Destination name
          <input name="name" required maxLength={120} className="control mt-1 w-full" placeholder="Fleet recordings" />
        </label>
        <label className="block text-xs font-medium text-neutral-500">Connected account
          <select name="credentials_secret_ref" value={reference} onChange={(event) => setReference(event.target.value)} className="control mt-1 w-full">
            {connections.map((c) => <option key={c.reference} value={c.reference}>{c.label} · {c.provider === "s3" ? "Amazon S3" : "MinIO"}</option>)}
          </select>
        </label>
        <input type="hidden" name="provider" value={connection.provider} />
        <label className="block text-xs font-medium text-neutral-500">Bucket
          <select key={`bucket-${reference}`} name="bucket" required className="control mt-1 w-full">
            {connection.buckets.map((bucket) => <option key={bucket} value={bucket}>{bucket}</option>)}
          </select>
        </label>
        <label className="block text-xs font-medium text-neutral-500">Region
          <input name="region" required defaultValue="us-east-1" className="control mt-1 w-full" placeholder="us-east-1" />
        </label>
        {connection.endpoints.length > 0 ? (
          <label className="block text-xs font-medium text-neutral-500">Storage endpoint
            <select key={`endpoint-${reference}`} name="endpoint" className="control mt-1 w-full">
              {connection.provider === "s3" && <option value="">Amazon S3 regional endpoint</option>}
              {connection.endpoints.map((endpoint) => <option key={endpoint} value={endpoint}>{endpoint}</option>)}
            </select>
          </label>
        ) : <input type="hidden" name="endpoint" value="" />}
      </div>
      <button type="submit" disabled={pending} className="button-primary">{pending ? "Adding…" : "Add destination"}</button>
      {!state.ok && state.error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{state.error}</p>}
    </form>
  );
}
