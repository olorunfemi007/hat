import type { CSSProperties } from "react";

export type IconName = "helmet" | "dashboard" | "sites" | "devices" | "storage" | "organization" | "arrow" | "plus" | "activity" | "offline";

const paths: Record<IconName, string> = {
  helmet: "M4 15v-3a8 8 0 0 1 5-7.4M15 4.6a8 8 0 0 1 5 7.4v3M9 12V4h6v8M3 15h18v4H3z",
  dashboard: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  sites: "M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0ZM15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  devices: "M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM10 6h4M11 18h2",
  storage: "M4 4h16v6H4zM4 14h16v6H4zM7 7h.01M7 17h.01M11 7h6M11 17h6",
  organization: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM22 21v-2a4 4 0 0 0-3-3.87M17 3.13a4 4 0 0 1 0 7.75",
  arrow: "M5 12h14M13 6l6 6-6 6",
  plus: "M12 5v14M5 12h14",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  offline: "M12 8v5M12 17h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
};

export function Icon({ name, className = "", style }: { name: IconName; className?: string; style?: CSSProperties }) {
  return (
    <svg className={`icon ${className}`} style={style} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
