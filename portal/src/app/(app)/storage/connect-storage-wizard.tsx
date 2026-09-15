"use client";

import { useState, useTransition } from "react";
import { beginAwsStorageConnection, saveAwsStorageConnection, connectMinioStorage, cancelStorageConnection } from "./connections-actions";
import type { StorageConnection } from "@/lib/storage/connection-types";

type Step = "closed" | "provider" | "aws-details" | "aws-role" | "minio-details";
export function ConnectStorageWizard({ trustPrincipalArn, connection }: {
  trustPrincipalArn: string | null; connection?: StorageConnection;
}) {
  const [step, setStep] = useState<Step>("closed");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<StorageConnection | null>(connection ?? null);
  const actionLabel = !connection ? "Connect storage" : connection.status === "pending" ? "Resume setup"
    : connection.status === "disconnected" ? "Reconnect" : "Replace credentials";
  function reset() { setStep("closed"); setError(null); setDraft(connection ?? null); }
  function run(action: () => Promise<void>) {
    setError(null);
    startTransition(async () => {
      try { await action(); }
      catch { setError("The request could not be completed. Try again."); }
    });
  }
  function close() {
    if (draft?.status === "pending") run(async () => {
      const result = await cancelStorageConnection(draft.id, draft.revision);
      if (!result.ok) { setError(result.error ?? "Could not cancel setup."); return; }
      reset();
    });
    else reset();
  }
  if (step === "closed") return <button type="button" className={connection ? "button-secondary" : "button-primary"}
    onClick={() => { setDraft(connection ?? null); setStep(!connection ? "provider" : connection.auth_mode === "role" ? "aws-role" : "minio-details"); }}>{actionLabel}</button>;

  const trustPolicy = trustPrincipalArn && draft?.external_id ? JSON.stringify({ Version: "2012-10-17", Statement: [{
    Effect: "Allow", Principal: { AWS: trustPrincipalArn }, Action: "sts:AssumeRole",
    Condition: { StringEquals: { "sts:ExternalId": draft.external_id } },
  }] }, null, 2) : null;

  function detailsFields() { return <>
    <label className="block text-xs font-medium text-neutral-500">Destination name
      <input name="name" required maxLength={120} className="control mt-1 w-full" placeholder="Fleet recordings" />
    </label>
    <label className="block text-xs font-medium text-neutral-500">Bucket
      <input name="bucket" required maxLength={63} className="control mt-1 w-full" placeholder="company-recordings" />
    </label>
    <label className="block text-xs font-medium text-neutral-500">Region
      <input name="region" required defaultValue="us-east-1" className="control mt-1 w-full" />
    </label>
  </>; }

  return <div className="surface min-w-0 w-full p-5 space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2>{actionLabel}</h2>
      <button type="button" disabled={pending} onClick={close} className="button-secondary">{draft?.status === "pending" ? "Cancel setup" : "Cancel"}</button>
    </div>
    {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    {step === "provider" && <div className="flex flex-wrap gap-3">
      <button className="button-primary" onClick={() => setStep("aws-details")}>Amazon S3</button>
      <button className="button-primary" onClick={() => setStep("minio-details")}>MinIO / S3-compatible</button>
    </div>}
    {step === "aws-details" && <form className="space-y-4" action={form => run(async () => {
      const result = await beginAwsStorageConnection(form);
      if (!result.ok || !result.connectionId || !result.externalId) { setError(result.error ?? "Could not start setup."); return; }
      setDraft({ id: result.connectionId, external_id: result.externalId, revision: 0, status: "pending", provider: "s3", auth_mode: "role",
        name: String(form.get("name")), bucket: String(form.get("bucket")), region: String(form.get("region")), endpoint: null, role_arn: null, config_id: null });
      setStep("aws-role");
    })}>
      {detailsFields()}
      <button disabled={pending} className="button-primary">{pending ? "Starting…" : "Continue"}</button>
    </form>}
    {step === "aws-role" && draft && <form className="space-y-4" action={form => run(async () => {
      form.set("connection_id", draft.id); form.set("revision", String(draft.revision));
      const result = await saveAwsStorageConnection(form);
      if (!result.ok) { setError(result.error ?? "Could not verify connection."); return; }
      reset();
    })}>
      <p className="text-sm break-words">Bucket <strong>{draft.bucket}</strong> · {draft.region}</p>
      <p className="text-sm text-neutral-500">Create or update your AWS role to require this external ID. We test that requests without the correct ID are rejected.</p>
      <div><p className="text-xs font-medium text-neutral-500">External ID</p><code className="block break-all text-xs mt-1">{draft.external_id}</code></div>
      {trustPolicy ? <details open><summary className="text-sm cursor-pointer">AWS trust policy</summary>
        <pre className="mt-2 max-w-full overflow-x-auto rounded bg-neutral-100 dark:bg-neutral-900 p-3 text-xs">{trustPolicy}</pre>
      </details> : <p className="text-sm text-neutral-500">Ask your portal administrator for the AWS principal to include in this role&apos;s trust policy.</p>}
      <p className="text-sm text-neutral-500">The role needs bucket listing, object read/write, versioned reads, and permission to delete connection-test objects. Your AWS administrator can use the portal&apos;s storage policy template.</p>
      <label className="block text-xs font-medium text-neutral-500">Role ARN
        <input name="role_arn" required defaultValue={draft.role_arn ?? ""} className="control mt-1 w-full" placeholder="arn:aws:iam::123456789012:role/HardhatUpload" />
      </label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="make_default" /> Make this the default destination</label>
      <button disabled={pending} className="button-primary">{pending ? "Verifying…" : "Test and connect"}</button>
      {draft.status === "pending" && <button type="button" disabled={pending} onClick={reset} className="button-secondary ml-2">Finish later</button>}
    </form>}
    {step === "minio-details" && <form className="space-y-4" action={form => run(async () => {
      if (connection) { form.set("connection_id", connection.id); form.set("revision", String(connection.revision)); }
      const result = await connectMinioStorage(form);
      if (!result.ok) { setError(result.error ?? "Could not verify connection."); return; }
      reset();
    })}>
      {connection ? <p className="text-sm break-all">{connection.bucket} · {connection.endpoint}<br />New credentials will be tested before replacing the stored credentials. Existing captures keep their destination.</p> : <>
        <p className="text-xs text-neutral-500">Works with MinIO, Backblaze B2, Cloudflare R2, or any other S3-compatible provider. For region, use your provider&apos;s own value — e.g. <code>us-west-004</code> for Backblaze B2 or <code>auto</code> for Cloudflare R2.</p>
        {detailsFields()}
        <label className="block text-xs font-medium text-neutral-500">Endpoint URL
          <input name="endpoint" required type="url" className="control mt-1 w-full" placeholder="https://storage.example.com" />
        </label>
      </>}
      <label className="block text-xs font-medium text-neutral-500">Access key ID
        <input name="access_key_id" required maxLength={256} className="control mt-1 w-full" autoComplete="off" />
      </label>
      <label className="block text-xs font-medium text-neutral-500">Secret access key
        <input name="secret_access_key" required maxLength={4096} type="password" className="control mt-1 w-full" autoComplete="new-password" />
      </label>
      <p className="text-xs text-neutral-500">Credentials are encrypted on the server and are never sent to hats.</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="make_default" /> Make this the default destination</label>
      <button disabled={pending} className="button-primary">{pending ? "Verifying…" : "Test and connect"}</button>
    </form>}
  </div>;
}
