import type { DeviceStatus } from "@/lib/supabase/types";

const STYLES: Record<DeviceStatus, string> = {
  unclaimed:
    "bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400",
  claimed:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  active: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  offline: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

export function StatusBadge({ status }: { status: DeviceStatus }) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${STYLES[status]}`}
    >
      {status}
    </span>
  );
}
