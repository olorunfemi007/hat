import { SignInForm } from "./sign-in-form";
import { safeRedirectPath } from "@/lib/redirect-path";

export default async function SignInPage({ searchParams }: {
  searchParams: Promise<{ redirect_to?: string | string[] }>;
}) {
  const { redirect_to } = await searchParams;
  return <SignInForm redirectTo={safeRedirectPath(redirect_to)} />;
}
