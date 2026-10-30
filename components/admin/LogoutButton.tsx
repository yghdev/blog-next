"use client";
import { useRouter } from "next/navigation";
import { IconLogout } from "./editor-icons";

export function LogoutButton({ username, variant = "default" }: {
  username: string;
  /** footer：侧栏底部的「图标 + 文字」样式；default：顶栏的紧凑按钮 */
  variant?: "default" | "footer";
}) {
  const router = useRouter();
  const className = variant === "footer" ? "admin-foot-link" : "btn btn-sm";
  return (
    <button
      className={className}
      title={`退出 ${username}`}
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        router.push("/admin/login");
        router.refresh();
      }}
    >
      {variant === "footer" ? <IconLogout size={16} /> : null}
      退出
    </button>
  );
}
