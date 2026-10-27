import { permanentRedirect } from "next/navigation";

/**
 * 旧地址 /admin/storage → /admin/settings/storage（阶段 02-5 设置拆页）。
 *
 * 用 308 而不是 404 或客户端跳转：这个地址可能已经被收藏过，
 * 而且"图片存储"确实还在，只是换了归类。用永久跳转把旧链接、
 * 书签和脚本一起带走，不留一条死路。
 *
 * 页面本身不再渲染任何内容 —— 只保留这一处跳转，避免出现"两套实现"。
 */
export const dynamic = "force-dynamic";

export default function LegacyStoragePage() {
  permanentRedirect("/admin/settings/storage");
}
