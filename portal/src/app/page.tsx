import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCurrentUserClaims } from "@/lib/org-context";

export default async function Home() {
  const supabase = await createServerSupabaseClient();
  const claims = await getCurrentUserClaims(supabase);

  if (claims) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen flex-1 flex-col items-center justify-center gap-8 p-6 text-center">
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Hard Hat Portal
        </h1>
        <p className="max-w-md text-neutral-600 dark:text-neutral-400">
          Manage your organization&apos;s sites, claim and monitor devices,
          and configure fleet data storage.
        </p>
      </div>
      <div className="flex gap-3">
        <Link
          href="/sign-in"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Sign in
        </Link>
        <Link
          href="/sign-up"
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Sign up
        </Link>
      </div>
    </div>
  );
}
