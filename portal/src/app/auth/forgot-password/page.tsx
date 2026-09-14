"use client";

import { Brand } from "@/components/brand";
import { useActionState } from "react";
import Link from "next/link";
import { requestPasswordReset, type AuthActionState } from "@/app/auth/actions";

const initialState: AuthActionState = { ok: false };

export default function ForgotPasswordPage() {
  const [state, action, pending] = useActionState(
    requestPasswordReset,
    initialState,
  );

  if (state.ok) {
    return (
      <div role="main" className="auth-page flex-col gap-4 text-center">
        <h1 className="page-title">
          Check your email
        </h1>
        <p className="max-w-sm text-sm text-neutral-600 dark:text-neutral-400">
          If an account exists for that email, we sent a link to reset your
          password.
        </p>
        <Link href="/sign-in" className="text-sm underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div role="main" className="auth-page">
      <form
        action={action}
        className="auth-card space-y-6"
      >
        <Brand />
        <div>
          <h1 className="page-title">
            Reset your password
          </h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Enter your email and we&apos;ll send you a reset link.
          </p>
        </div>

        <div>
          <label className="block text-xs font-medium text-neutral-500">
            Email
            <input
              type="email"
              name="email"
              required
              autoComplete="email"
              className="mt-1 w-full control px-3 py-2 text-sm"
            />
          </label>
        </div>

        <button
          type="submit"
          disabled={pending}
          className="button-primary w-full disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send reset link"}
        </button>

        <p className="text-center text-xs text-neutral-500">
          <Link href="/sign-in" className="underline">
            Back to sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
