"use client";

import { useState, useTransition } from "react";
import { revokeInvite } from "./actions";
import { ROLE_LABELS, type OrgRole } from "@/lib/roles";
import type { OrganizationInvite } from "@/lib/supabase/types";

export function PendingInvites({
  invites,
}: {
  invites: OrganizationInvite[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (invites.length === 0) {
    return <p className="text-sm text-neutral-500">No pending invites.</p>;
  }

  return (
    <div className="space-y-2">
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
      <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
        {invites.map((invite) => (
          <li
            key={invite.id}
            className="flex flex-wrap items-center justify-between gap-2 py-2"
          >
            <div>
              <p className="text-sm">{invite.email}</p>
              <p className="text-xs text-neutral-500">
                {ROLE_LABELS[invite.role as OrgRole]} · invited{" "}
                {new Date(invite.created_at).toLocaleDateString()}
              </p>
            </div>
            <button
              disabled={pending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await revokeInvite(invite.id);
                  if (!result.ok) setError(result.error ?? "Failed.");
                });
              }}
              className="text-xs text-red-600 underline disabled:opacity-50 dark:text-red-400"
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
