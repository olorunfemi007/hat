"use client";

import { useActionState } from "react";
import { inviteMember } from "./actions";
import { ORG_ROLES, ROLE_LABELS } from "@/lib/roles";
import type { ActionResult } from "../sites/actions";

const initialState: ActionResult = { ok: true };

export function InviteForm() {
  const [state, action, pending] = useActionState(
    async (_prev: ActionResult, formData: FormData) => inviteMember(formData),
    initialState,
  );

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <div>
        <label className="block text-xs font-medium text-neutral-500">
          Email
          <input
            type="email"
            name="email"
            required
            className="mt-1 control px-3 py-2 text-sm"
          />
        </label>
      </div>
      <div>
        <label className="block text-xs font-medium text-neutral-500">
          Role
          <select
            name="role"
            defaultValue="viewer"
            className="mt-1 control px-3 py-2 text-sm"
          >
            {ORG_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button
        type="submit"
        disabled={pending}
        className="button-primary disabled:opacity-50"
      >
        {pending ? "Inviting…" : "Invite"}
      </button>
      {!state.ok && state.error && (
        <p className="w-full text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
    </form>
  );
}
