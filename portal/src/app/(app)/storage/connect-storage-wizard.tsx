"use client";

import { useState, useTransition } from "react";
import { beginAwsStorageConnection, saveAwsStorageConnection, connectMinioStorage } from "./connections-actions";

type Step = "closed" | "provider" | "aws-details" | "aws-role" | "minio-details";

/**
 * Self-service replacement for an operator hand-editing
 * HARDHAT_STORAGE_CREDENTIALS per customer: an org_admin connects their own
 * AWS account (via a guided IAM role + external_id, real-verified with a
 * live AssumeRole + test upload before anything is saved) or MinIO account
 * (a key form, same real test) directly from this page.
 */
export function ConnectStorageWizard({ trustPrincipalArn }: { trustPrincipalArn: string | null }) {
  const [step, setStep] = useState<Step>("closed");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [externalId, setExternalId] = useState<string | null>(null);
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("us-east-1");

  function reset() {
    setStep("closed"); setError(null); setConnectionId(null); setExternalId(null);
  }

  if (step === "closed") {
    return <button type="button" onClick={() => setStep("provider")} className="button-primary">Connect storage</button>;
  }

  const trustPolicy = trustPrincipalArn && externalId ? JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { AWS: trustPrincipalArn },
      Action: "sts:AssumeRole",
      Condition: { StringEquals: { "sts:ExternalId": externalId } },
    }],
  }, null, 2) : null;

  return (
    <div className="surface p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h2>Connect storage</h2>
        <button type="button" onClick={reset} className="text-sm text-neutral-500 underline">Cancel</button>
      </div>
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {step === "provider" && (
        <div className="flex flex-wrap gap-3">
          <button type="button" className="button-primary" onClick={() => setStep("aws-details")}>Amazon S3</button>
          <button type="button" className="button-primary" onClick={() => setStep("minio-details")}>MinIO / S3-compatible</button>
        </div>
      )}

      {step === "aws-details" && (
        <form
          action={(formData) => {
            setError(null);
            startTransition(async () => {
              const result = await beginAwsStorageConnection(formData);
              if (!result.ok || !result.connectionId || !result.externalId) {
                setError(result.error ?? "Could not start this connection.");
                return;
              }
              setConnectionId(result.connectionId);
              setExternalId(result.externalId);
              setBucket(String(formData.get("bucket") ?? ""));
              setRegion(String(formData.get("region") ?? "us-east-1"));
              setStep("aws-role");
            });
          }}
          className="space-y-4"
        >
          <label className="block text-xs font-medium text-neutral-500">Destination name
            <input name="name" required maxLength={120} className="control mt-1 w-full" placeholder="Fleet recordings" />
          </label>
          <label className="block text-xs font-medium text-neutral-500">Bucket
            <input name="bucket" required className="control mt-1 w-full" placeholder="my-company-hardhat-recordings" />
          </label>
          <label className="block text-xs font-medium text-neutral-500">Region
            <input name="region" required defaultValue="us-east-1" className="control mt-1 w-full" placeholder="us-east-1" />
          </label>
          <button type="submit" disabled={pending} className="button-primary">{pending ? "Starting…" : "Continue"}</button>
        </form>
      )}

      {step === "aws-role" && connectionId && externalId && (
        <form
          action={(formData) => {
            setError(null);
            formData.set("connection_id", connectionId);
            formData.set("revision", "0");
            startTransition(async () => {
              const result = await saveAwsStorageConnection(formData);
              if (!result.ok) { setError(result.error ?? "Could not verify this connection."); return; }
              reset();
            });
          }}
          className="space-y-4"
        >
          <div className="rounded-md bg-neutral-100 dark:bg-neutral-900 p-4 text-sm space-y-3">
            <p>In your AWS account, create an IAM role that:</p>
            <ol className="list-decimal list-inside space-y-1 text-neutral-600 dark:text-neutral-400">
              <li>Trusts the principal and external ID below to assume it</li>
              <li>Grants read/write access to bucket <strong>{bucket}</strong> in <strong>{region}</strong></li>
            </ol>
            <div>
              <p className="text-xs font-medium text-neutral-500">External ID (unique to this connection -- required in the trust policy)</p>
              <code className="mt-1 block rounded bg-white dark:bg-neutral-800 px-3 py-2 font-mono text-xs break-all">{externalId}</code>
            </div>
            {trustPolicy ? (
              <div>
                <p className="text-xs font-medium text-neutral-500">Trust policy</p>
                <pre className="mt-1 overflow-x-auto rounded bg-white dark:bg-neutral-800 px-3 py-2 font-mono text-xs">{trustPolicy}</pre>
              </div>
            ) : (
              <p className="text-xs text-neutral-500">This deployment hasn&apos;t configured HARDHAT_AWS_TRUST_PRINCIPAL_ARN yet -- contact support for the exact trust-policy principal to use alongside the external ID above.</p>
            )}
          </div>
          <label className="block text-xs font-medium text-neutral-500">Role ARN
            <input name="role_arn" required className="control mt-1 w-full" placeholder="arn:aws:iam::123456789012:role/HardhatUpload" />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="make_default" /> Make this the default destination
          </label>
          <button type="submit" disabled={pending} className="button-primary">{pending ? "Verifying…" : "Test and connect"}</button>
        </form>
      )}

      {step === "minio-details" && (
        <form
          action={(formData) => {
            setError(null);
            startTransition(async () => {
              const result = await connectMinioStorage(formData);
              if (!result.ok) { setError(result.error ?? "Could not verify this connection."); return; }
              reset();
            });
          }}
          className="space-y-4"
        >
          <label className="block text-xs font-medium text-neutral-500">Destination name
            <input name="name" required maxLength={120} className="control mt-1 w-full" placeholder="Fleet recordings" />
          </label>
          <label className="block text-xs font-medium text-neutral-500">Endpoint URL
            <input name="endpoint" required type="url" className="control mt-1 w-full" placeholder="https://minio.example.com" />
          </label>
          <label className="block text-xs font-medium text-neutral-500">Bucket
            <input name="bucket" required className="control mt-1 w-full" />
          </label>
          <label className="block text-xs font-medium text-neutral-500">Region
            <input name="region" defaultValue="us-east-1" className="control mt-1 w-full" />
          </label>
          <label className="block text-xs font-medium text-neutral-500">Access key ID
            <input name="access_key_id" required className="control mt-1 w-full" autoComplete="off" />
          </label>
          <label className="block text-xs font-medium text-neutral-500">Secret access key
            <input name="secret_access_key" required type="password" className="control mt-1 w-full" autoComplete="off" />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="make_default" /> Make this the default destination
          </label>
          <button type="submit" disabled={pending} className="button-primary">{pending ? "Verifying…" : "Test and connect"}</button>
        </form>
      )}
    </div>
  );
}
