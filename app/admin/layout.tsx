import "./admin.css";
import { cookies } from "next/headers";
import { NAV_COLLAPSE_COOKIE, parseCollapsed } from "@/components/admin/nav-config";
import { AdminNavProvider } from "@/components/admin/AdminNavContext";

/**
 * 后台布局：只做两件事 —— 加载后台样式、把导航折叠偏好从 cookie 交给客户端。
 *
 * 折叠偏好为什么在服务端读：见 AdminShell 顶部注释。localStorage 要等
 * hydration，导航时会先"全展开"再合上，实测 80–90ms 的闪烁。
 *
 * 读 cookie 会让 /admin 下的路由变成按请求渲染 —— 后台本来就是全动态的
 * （每页都在查库、验会话），登录页也只是多渲染一次静态表单，代价可以忽略。
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const raw = (await cookies()).get(NAV_COLLAPSE_COOKIE)?.value;
  return <AdminNavProvider initialCollapsed={parseCollapsed(raw)}>{children}</AdminNavProvider>;
}
