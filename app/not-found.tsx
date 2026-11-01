import Link from "next/link";

/**
 * 404 页。
 *
 * 结构原本全是内联样式（C-5 改为语义类）：这样排版参数集中在
 * `globals.css` 的 `.notfound*` 里，与其他页面的字号刻度保持一致，
 * 以后想统一调也只需要改一处。
 */
export default function NotFound() {
  return (
    <div className="notfound">
      <h1 className="notfound-title">404</h1>
      <p className="notfound-text">这个页面不存在</p>
      <Link href="/" className="btn">回到首页</Link>
    </div>
  );
}
