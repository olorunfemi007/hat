"use client";

import { useState, useTransition } from "react";
import { deleteStorageConfig, setDefaultStorage, setStorageEnabled, testStorageConfig } from "./actions";
import type { StorageConfig } from "@/lib/supabase/types";
import type { ActionResult } from "../sites/actions";

const PROVIDER_LABELS = { s3: "Amazon S3", azure_blob: "Azure Blob Storage", gcs: "Google Cloud Storage", minio: "MinIO" };

export function StorageConfigRow({ config }: { config: StorageConfig }) {
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<ActionResult | null>(null);
  const [operation, setOperation] = useState("");
  const supported = ["s3", "minio"].includes(config.provider);
  function run(label: string, action: () => Promise<ActionResult>) {
    setFeedback(null); setOperation(label);
    startTransition(async () => {
      try { setFeedback(await action()); }
      catch { setFeedback({ ok: false, error: "The request could not be completed. Try again." }); }
    });
  }
  return (
    <li className="space-y-4 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{config.name || config.bucket}</p>
          <p className="text-xs text-neutral-500">{PROVIDER_LABELS[config.provider]} · {config.bucket}{config.region ? ` · ${config.region}` : ""}</p>
          {config.endpoint && <p className="text-xs text-neutral-500 break-all">{config.endpoint}</p>}
        </div>
        <span className="role-badge">{config.disabled_at ? "Paused" : config.is_default ? "Fleet default" : config.verified_at ? "Tested" : "Needs a test"}</span>
      </div>
      {!supported && <p className="text-sm text-neutral-500">Automatic capture delivery for this provider is not available in this release.</p>}
      {config.verified_at && <p className="text-xs text-neutral-500">Delivery verified {new Date(config.verified_at).toLocaleString()}</p>}
      {config.verification_error && <p className="text-sm text-red-600 dark:text-red-400">{config.verification_error}</p>}
      <div className="flex flex-wrap gap-2">
        {supported && !config.disabled_at && <button disabled={pending} className="button-secondary" onClick={() => run("test", () => testStorageConfig(config.id))}>{pending && operation === "test" ? "Testing delivery…" : "Test connection"}</button>}
        {supported && !config.disabled_at && config.verified_at && !config.is_default && <button disabled={pending} className="button-primary" onClick={() => run("default", () => setDefaultStorage(config.id))}>Use as default</button>}
        {supported && <button disabled={pending} className="button-secondary" onClick={() => run("state", () => setStorageEnabled(config.id, Boolean(config.disabled_at)))}>{config.disabled_at ? "Resume" : "Pause"}</button>}
        <button disabled={pending} className="button-danger" onClick={() => run("remove", () => deleteStorageConfig(config.id))}>Remove</button>
      </div>
      {feedback && <p role="status" className={`text-sm ${feedback.ok ? "text-neutral-500" : "text-red-600 dark:text-red-400"}`}>{feedback.ok ? (operation === "test" ? "Test capture uploaded, verified, and cleaned up successfully." : "Destination updated.") : feedback.error}</p>}
    </li>
  );
}
