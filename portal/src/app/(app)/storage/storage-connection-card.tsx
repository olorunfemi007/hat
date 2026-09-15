"use client";
import { useState, useTransition } from "react";
import type { StorageConnection, StorageConnectionEvent } from "@/lib/storage/connection-types";
import { cancelStorageConnection, disconnectStorageConnection } from "./connections-actions";
import { ConnectStorageWizard } from "./connect-storage-wizard";
import type { ActionResult } from "../sites/actions";

const eventLabels: Record<string, string> = { setup_started: "Setup started", connected: "Connected", credentials_rotated: "Credentials replaced", disconnected: "Disconnected", reconnected: "Reconnected", setup_cancelled: "Setup cancelled" };
export function StorageConnectionCard({ connection, events, trustPrincipalArn }: {
  connection: StorageConnection; events: StorageConnectionEvent[]; trustPrincipalArn: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<ActionResult | null>(null);
  function run(action: () => Promise<ActionResult>) {
    startTransition(async () => {
      try { setFeedback(await action()); }
      catch { setFeedback({ ok: false, error: "The request could not be completed. Try again." }); }
    });
  }
  return <li className="surface min-w-0 p-5 space-y-4">
    <div className="flex flex-wrap justify-between gap-3">
      <div className="min-w-0"><h3 className="text-sm font-semibold break-words">{connection.name}</h3>
        <p className="text-xs text-neutral-500 break-all">{connection.provider === "s3" ? "Amazon S3" : "MinIO"} · {connection.bucket}</p>
      </div>
      <span className="role-badge self-start">{connection.status === "pending" ? "Setup unfinished" : connection.status === "connected" ? "Connected" : "Disconnected"}</span>
    </div>
    <div className="flex flex-wrap items-start gap-2">
      <ConnectStorageWizard connection={connection} trustPrincipalArn={trustPrincipalArn} />
      {connection.status === "pending" && <button disabled={pending} className="button-secondary" onClick={() => run(() => cancelStorageConnection(connection.id, connection.revision))}>Cancel setup</button>}
      {connection.status === "connected" && <button disabled={pending} className="button-danger" onClick={() => run(() => disconnectStorageConnection(connection.id, connection.revision))}>{pending ? "Disconnecting…" : "Disconnect"}</button>}
    </div>
    {connection.status === "connected" && <p className="text-xs text-neutral-500">Disconnect removes stored credentials and stops new upload permissions. Permissions already issued expire within five minutes.</p>}
    {connection.status === "disconnected" && <p className="text-xs text-neutral-500">Reconnect to resume delivery to this destination. Captures remain on the hats until verified.</p>}
    {feedback && !feedback.ok && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{feedback.error}</p>}
    {events.length > 0 && <details><summary className="text-sm cursor-pointer">Connection history</summary>
      <ul className="mt-3 space-y-2 text-xs text-neutral-500">{events.map(event => <li key={event.id}>
        {eventLabels[event.event] ?? "Connection updated"} · {new Date(event.created_at).toLocaleString()}
        {event.actor_id && <span className="block break-all">Account {event.actor_id}</span>}
      </li>)}</ul>
    </details>}
  </li>;
}
