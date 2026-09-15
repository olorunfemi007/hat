import type { DeviceStatus } from "@/lib/supabase/types";

const STYLES: Record<DeviceStatus, string> = {
  unclaimed:
    "bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400",
  claimed:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  active: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  offline: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

// Display text only -- the underlying "active" status value is unchanged
// (still what's stored and returned by device_heartbeat), this just reads
// better paired against "Offline" than "Active" does.
const LABELS: Record<DeviceStatus, string> = {
  unclaimed: "Unclaimed",
  claimed: "Claimed",
  active: "Online",
  offline: "Offline",
};

export function StatusBadge({ status }: { status: DeviceStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${STYLES[status]}`}
    >
      <span className="status-dot" aria-hidden="true" />
      {LABELS[status]}
    </span>
  );
}
