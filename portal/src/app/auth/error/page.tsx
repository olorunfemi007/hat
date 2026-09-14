import { Brand } from "@/components/brand";
import Link from "next/link";

export default function AuthErrorPage() {
  return (
    <div role="main" className="auth-page flex-col gap-4 text-center">
      <Brand />
      <h1 className="page-title">
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
