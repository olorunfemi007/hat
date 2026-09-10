"use client";

import { useTransition } from "react";
import { switchActiveOrg } from "./actions";

export function OrgSwitcher({
  orgs,
  currentOrgId,
}: {
  orgs: { id: string; name: string }[];
  currentOrgId: string;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <select
      aria-label="Active organization"
      value={currentOrgId}
      disabled={pending}
      onChange={(e) => {
        const orgId = e.target.value;
        startTransition(async () => {
          await switchActiveOrg(orgId);
        });
      }}
      className="min-w-0 max-w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
    >
      {orgs.map((org) => (
        <option key={org.id} value={org.id}>
          {org.name}
        </option>
      ))}
    </select>
  );
}
