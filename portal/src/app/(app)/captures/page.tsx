import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/org-context";
import { canManageDevices, canManageStorage } from "@/lib/roles";
import type { Capture, Device, DeviceSyncStatus } from "@/lib/supabase/types";
import { UploadControl } from "./upload-control";

const STATUS_LABELS = { queued: "Queued", uploading: "Uploading", verified: "Verified", needs_attention: "Needs attention" };
function bytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
function date(value: string | null) { return value ? new Date(value).toLocaleString() : "Not yet"; }

export default async function CapturesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const filter = typeof status === "string" && Object.hasOwn(STATUS_LABELS, status) ? status : "";
  const supabase = await createServerSupabaseClient();
  const { role } = await getOrgContext(supabase);
  let query = supabase.from("captures").select("*").order("created_at", { ascending: false }).limit(100);
  if (filter) query = query.eq("status", filter);
  const [capturesResult, syncResult, devicesResult] = await Promise.all([
    query.returns<Capture[]>(),
    supabase.from("device_sync_status").select("*").returns<DeviceSyncStatus[]>(),
    supabase.from("devices").select("id, serial_number, display_name, upload_revoked_at").order("serial_number").returns<Pick<Device, "id" | "serial_number" | "display_name" | "upload_revoked_at">[]>(),
  ]);
  const captures = capturesResult.data ?? [];
  const devices = devicesResult.data ?? [];
  const sync = new Map((syncResult.data ?? []).map((s) => [s.device_id, s]));
  const names = new Map(devices.map((d) => [d.id, d.display_name || d.serial_number]));
  const failed = capturesResult.error || syncResult.error || devicesResult.error;
  // This async Server Component renders a request-time snapshot, not a client clock.
  // eslint-disable-next-line react-hooks/purity
  const renderedAt = Date.now();
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap justify-between items-center gap-4">
        <div><h1 className="page-title">Captures</h1><p className="text-sm text-neutral-500">Follow each recording from your hat to verified storage.</p></div>
        <div className="flex gap-2">
          {canManageStorage(role) && <Link href="/storage" className="button-secondary">Manage storage</Link>}
          <a href={filter ? `/captures?status=${filter}` : "/captures"} className="button-secondary">Refresh</a>
        </div>
      </div>
      {failed && <p role="alert" className="surface p-4 text-sm text-red-600 dark:text-red-400">Some sync data could not be loaded. The information below may be incomplete.</p>}
      <section className="surface p-6 space-y-4" aria-labelledby="sync-heading">
        <div><h2 id="sync-heading">Device sync</h2><p className="text-sm text-neutral-500 mt-1">Queue totals reflect each hat&apos;s last report. Pausing uploads keeps recordings on the hat; permissions already issued expire within five minutes.</p></div>
        {devices.length === 0 && <p className="text-sm text-neutral-500 py-6">Claim a device to start capturing.</p>}
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
          {devices.map((device) => {
            const snapshot = sync.get(device.id);
            const stale = snapshot && renderedAt - new Date(snapshot.last_contact_at).getTime() > 3 * 60_000;
            return (
              <li key={device.id} className="flex flex-wrap items-center justify-between gap-4 py-5">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm">{device.display_name || device.serial_number}{device.upload_revoked_at && <span className="role-badge ml-2">Uploads paused</span>}</p>
                  {snapshot ? <>
                    <p className="text-xs text-neutral-500">{snapshot.queued_count} queued · {bytes(snapshot.queued_bytes)} · Last report {date(snapshot.last_contact_at)}{stale ? " (out of date)" : ""}</p>
                    <p className="text-xs text-neutral-500">Last verified delivery: {date(snapshot.last_verified_at)}</p>
                    {snapshot.last_error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{snapshot.last_error}</p>}
                  </> : <p className="text-xs text-neutral-500">Waiting for the capture sync service to report.</p>}
                </div>
                {canManageDevices(role) && <UploadControl deviceId={device.id} disabled={Boolean(device.upload_revoked_at)} />}
              </li>
            );
          })}
        </ul>
      </section>
      <section className="space-y-4" aria-labelledby="recent-heading">
        <div className="flex flex-wrap justify-between items-center gap-3">
          <h2 id="recent-heading" className="text-lg font-semibold">Recent captures</h2>
          <form className="flex flex-wrap items-end gap-2" action="/captures">
            <label className="text-xs text-neutral-500">Delivery status
              <select name="status" defaultValue={filter} className="control ml-2">
                <option value="">All statuses</option>
                {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <button className="button-secondary" type="submit">Filter</button>
          </form>
        </div>
        <ul className="surface divide-y divide-neutral-200 px-6 dark:divide-neutral-700">
          {captures.length === 0 && <li className="py-12 text-center text-sm text-neutral-500">{filter ? "No captures with this delivery status." : "No captures reported yet. Recordings waiting offline will appear when the hat reconnects and a destination is available."}</li>}
          {captures.map((capture) => (
            <li key={capture.capture_id} className="py-5 space-y-3">
              <div className="flex flex-wrap justify-between gap-3">
                <div><p className="font-medium text-sm">{names.get(capture.device_id) || "Device"} · <span className="capitalize">{capture.kind}</span></p><p className="text-xs text-neutral-500">{date(capture.captured_at)} · {bytes(capture.byte_size)}</p></div>
                <span className={`role-badge self-start ${capture.status === "verified" ? "text-green-800 dark:text-green-300" : capture.status === "needs_attention" ? "text-red-700 dark:text-red-300" : ""}`}>{STATUS_LABELS[capture.status]}</span>
              </div>
              {capture.last_error && <p className="text-sm text-red-600 dark:text-red-400">{capture.last_error}</p>}
              <details className="text-xs text-neutral-500">
                <summary className="cursor-pointer py-2">Delivery details</summary>
                <dl className="space-y-2 mt-2 break-all">
                  <div><dt className="font-medium">Capture ID</dt><dd className="font-mono">{capture.capture_id}</dd></div>
                  <div><dt className="font-medium">Storage object</dt><dd className="font-mono">{capture.object_key}</dd></div>
                  <div><dt className="font-medium">SHA-256</dt><dd className="font-mono">{capture.sha256}</dd></div>
                  <div><dt className="font-medium">Verified at</dt><dd>{date(capture.verified_at)}</dd></div>
                </dl>
              </details>
            </li>
          ))}
        </ul>
        <p className="text-xs text-neutral-500">Showing the latest {captures.length} captures, up to 100. Verified means the stored object&apos;s size and checksum were independently checked.</p>
      </section>
    </div>
  );
}
