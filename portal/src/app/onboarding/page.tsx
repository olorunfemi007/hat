import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/org-context";
import { CreateOrgForm } from "./create-org-form";

/**
 * Landing spot for a signed-in user with no active organization. Reached
 * only by someone with genuinely ZERO memberships anywhere -- if they had
 * even one, current_org_id() would already resolve to it (its own fallback
 * is "the caller's earliest organization_members row" when no explicit
 * active-org choice has been made yet), and (app)/layout.tsx would never
 * have redirected them here in the first place. So this page only needs a
 * "create an organization" flow, not an org-picker.
 */
export default async function OnboardingPage() {
  const supabase = await createServerSupabaseClient();
  const { userId, orgId } = await getOrgContext(supabase);

  if (!userId) {
    redirect("/sign-in");
  }
  if (orgId) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen flex-1 flex-col items-center justify-center gap-6 p-6">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          Create your organization
        </h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          You need an organization to use the portal -- sites, devices, and
          storage configs all belong to one. You&apos;ll be its first admin,
          and can invite teammates once it&apos;s created.
        </p>
      </div>
      <CreateOrgForm />
    </div>
  );
}
