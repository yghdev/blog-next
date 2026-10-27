"use client";
import { usePathname } from "next/navigation";

/** Public-site chrome must never leak into the admin workspace. */
export function FrontOnly({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return null;
  return children;
}
