// Next.js 16 renamed `middleware.ts` to `proxy.ts` (network-boundary
// clarity; runs on Node.js, not Edge). `middleware.ts` still works today but
// is deprecated, and this project's `next` version is 16.x, so this uses the
// new filename.
//
// Actual logic lives in src/lib/supabase/middleware.ts (session refresh +
// public-route allowlist) -- kept separate so it's testable/reusable
// independent of this file's Next.js-specific export shape.
import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export default async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Skip Next.js internals and static assets, unless found in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
