import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { prepareUpload, verifyUpload, persistCaptureMetadata } from "@/lib/storage";
import { createSyncHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Allows bounded data verification plus metadata write/verification to finish.
export const maxDuration = 120;

// Machine authentication is performed on EVERY request inside the handler.
// This route intentionally does not use browser cookies or organization input.
export const POST = createSyncHandler({ createAdmin: createAdminSupabaseClient, prepareUpload, verifyUpload, persistCaptureMetadata });
