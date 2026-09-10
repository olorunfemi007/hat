"use client";

// Catches errors thrown during rendering of any page under the (app) route
// group (e.g. an unhandled Supabase client-side error) - the read pages
// under this group already surface their own query errors as inline
// banners rather than throwing, so this is a backstop for anything that
// isn't a plain data-fetch error (a bug, a thrown exception in a Client
// Component, etc.), not the primary error-handling path.
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
      <p className="text-sm font-medium text-red-600 dark:text-red-400">
        Something went wrong loading this page.
      </p>
      {error.digest && (
        <p className="text-xs text-neutral-500">Reference: {error.digest}</p>
      )}
      <button
        onClick={() => reset()}
        className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
      >
        Try again
      </button>
    </div>
  );
}
