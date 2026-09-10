"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { OrgRole } from "@/lib/roles";
import { canManageStorage } from "@/lib/roles";

const BASE_LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/sites", label: "Sites" },
  { href: "/devices", label: "Devices" },
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
    <nav className="flex flex-wrap gap-1 md:flex-col">
      {links.map((link) => {
        const active =
          pathname === link.href || pathname?.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                : "text-neutral-700 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-800"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
