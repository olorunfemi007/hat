"use client";

import { useState, useTransition } from "react";
import { changeMemberRole, removeMember } from "./actions";
import { ORG_ROLES, ROLE_LABELS } from "@/lib/roles";
import type { MemberWithEmail } from "@/lib/supabase/types";

export function MemberList({
  members,
  canManage,
  currentUserId,
}: {
  members: MemberWithEmail[];
  canManage: boolean;
  currentUserId: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (members.length === 0) {
    return <p className="text-sm text-neutral-500">No members yet.</p>;
  }

  return (
    <div className="space-y-2">
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
      <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
        {members.map((m) => {
          const isSelf = m.user_id === currentUserId;
          return (
            <li
              key={m.user_id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <div>
                <p className="text-sm">
                  {m.email}
                  {isSelf && (
                    <span className="ml-1 text-xs text-neutral-500">
                      (you)
                    </span>
                  )}
                </p>
                <p className="text-xs text-neutral-500">
                  Joined {new Date(m.created_at).toLocaleDateString()}
                </p>
              </div>

              {canManage ? (
                <div className="flex items-center gap-2">
                  <select
                    aria-label={`Role for ${m.email}`}
                    value={m.role}
                    disabled={pending}
                    onChange={(e) => {
                      const nextRole = e.target.value;
                      setError(null);
                      startTransition(async () => {
                        const result = await changeMemberRole(
                          m.user_id,
                          nextRole,
                        );
                        if (!result.ok) setError(result.error ?? "Failed.");
                      });
                    }}
                    className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-xs dark:border-neutral-700"
                  >
                    {ORG_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                  <button
                    disabled={pending}
                    onClick={() => {
                      if (
                        !confirm(
                          isSelf
                            ? "Leave this organization?"
                            : `Remove ${m.email} from this organization?`,
                        )
                      ) {
                        return;
                      }
                      setError(null);
                      startTransition(async () => {
                        const result = await removeMember(m.user_id);
                        if (!result.ok) setError(result.error ?? "Failed.");
                      });
                    }}
                    className="text-xs text-red-600 underline disabled:opacity-50 dark:text-red-400"
                  >
                    {isSelf ? "Leave" : "Remove"}
                  </button>
                </div>
              ) : (
                <span className="text-xs text-neutral-500">
                  {ROLE_LABELS[m.role]}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
