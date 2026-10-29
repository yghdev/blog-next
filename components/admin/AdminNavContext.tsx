"use client";
import { createContext, useContext } from "react";

/**
 * 导航折叠偏好的服务端初值。
 *
 * 为什么需要一层 Context：折叠状态必须由服务端（读 cookie）决定首帧，
 * 而 AdminShell 是各个页面各自渲染的客户端组件。若把 collapsedGroups
 * 作为 prop 往下传，就要改 10 个页面的签名；Context 让布局只负责注入一次。
 */
const AdminNavContext = createContext<string[]>([]);

export function AdminNavProvider({ initialCollapsed, children }: {
  initialCollapsed: string[];
  children: React.ReactNode;
}) {
  return <AdminNavContext.Provider value={initialCollapsed}>{children}</AdminNavContext.Provider>;
}

export function useInitialCollapsed(): string[] {
  return useContext(AdminNavContext);
}
