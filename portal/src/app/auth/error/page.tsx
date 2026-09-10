import Link from "next/link";

export default function AuthErrorPage() {
  return (
    <div className="flex min-h-screen flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-semibold tracking-tight">
        This link didn&apos;t work
      </h1>
      <p className="max-w-sm text-sm text-neutral-600 dark:text-neutral-400">
        The confirmation or password-reset link is invalid or has expired.
        Links are single-use and time-limited -- request a new one.
      </p>
      <div className="flex gap-3 text-sm">
        <Link href="/sign-in" className="underline">
          Sign in
        </Link>
        <Link href="/auth/forgot-password" className="underline">
          Reset password
        </Link>
      </div>
    </div>
  );
}
