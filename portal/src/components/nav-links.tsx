"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { OrgRole } from "@/lib/roles";
import { canManageStorage } from "@/lib/roles";
import { Icon, type IconName } from "./icon";

const NAV_ICONS: Record<string, IconName> = {
  "/dashboard": "dashboard", "/sites": "sites", "/devices": "devices",
  "/storage": "storage", "/org": "organization",
  "/captures": "activity",
};

const BASE_LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/sites", label: "Sites" },
  { href: "/devices", label: "Devices" },
  { href: "/captures", label: "Captures" },
] as const;

export function NavLinks({ role }: { role: OrgRole | null }) {
  const pathname = usePathname();
  const links = [
    ...BASE_LINKS,
    ...(canManageStorage(role)
      ? [{ href: "/storage", label: "Storage" } as const]
      : []),
    { href: "/org", label: "Organization" } as const,
  ];

  return (
    <nav className="workspace-nav" aria-label="Main navigation">
      {links.map((link) => {
        const active =
          pathname === link.href || pathname?.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={`nav-link ${active ? "nav-link-active" : ""}`}
          >
            <Icon name={NAV_ICONS[link.href]} />
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
