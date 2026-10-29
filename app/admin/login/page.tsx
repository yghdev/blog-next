"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * 后台登录（移动端设计系统 · 参考 04 紧凑表单）。
 *
 * 手机端三处硬约束：
 *   1) 两步验证码必须 inputMode="numeric" + autoComplete="one-time-code"，
 *      否则 iOS 弹全键盘、也拿不到系统短信/验证器的一键填入；
 *   2) 输入框字号 ≥16px（在 globals.css 里按断点钉死），否则 Safari 聚焦会
 *      强制放大整页且不会缩回；
 *   3) 主按钮全宽 + 48dp 高，落在拇指可控区，不在顶部 1/3 的够不着区。
 */
/**
 * next 参数必须被尊重。
 *
 * proxy.ts 把未登录的后台请求重定向成 /admin/login?next=/admin/edit/34，
 * 但早期登录页从不读它，登录成功一律 push("/admin") —— 用户正在写的那篇文章
 * 就再也回不去了（线上"登录后总是在列表页"的抱怨即此）。
 * 只接受站内绝对路径，挡掉 //evil.com 这类开放重定向。
 */
function safeNext(raw: string | null): string {
  if (!raw) return "/admin";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/admin";
  return raw;
}

function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = safeNext(searchParams.get("next"));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, totp }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      router.push(nextPath);
      router.refresh();
    } else {
      setErr(d.error || "登录失败");
      if (d.needTotp) setNeedTotp(true);
    }
  };

  return (
    <div className="login-wrap fx-scope">
      <div className="login-card">
        {/* 登录页是后台品牌的第一落点：进来第一眼就该认出这是哪个站点的后台，
            而不是一个通用登录框。品牌标识与侧栏同源（.fx-brandmark）。 */}
        <div className="login-brand">
          <span className="fx-brandmark">flechazo</span>
          <span className="fx-brand-sub">妄司逸的小世界</span>
        </div>
        <h1 className="login-title">后台登录</h1>
        <p className="login-sub">仅站长可访问</p>

        <form onSubmit={submit} noValidate>
          {err ? <div className="notice notice-error" role="alert">{err}</div> : null}
          <div className="field">
            <label htmlFor="login-user">账号</label>
            <input
              id="login-user"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="login-pass">密码</label>
            <input
              id="login-pass"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          {needTotp ? (
            <div className="field">
              <label htmlFor="login-totp">两步验证码</label>
              <input
                id="login-totp"
                className="input"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="6 位数字"
                autoComplete="one-time-code"
                autoFocus
                required
              />
            </div>
          ) : null}
          <button className="btn btn-primary login-submit" disabled={busy} type="submit">
            {busy ? "登录中…" : "登录"}
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * useSearchParams 必须包一层 Suspense，否则 Next 在静态预渲染阶段会报
 * "missing suspense boundary with useSearchParams"（构建直接失败）。
 * 登录页本身是动态的，这层只是满足框架约束。
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<div className="login-wrap fx-scope"><div className="login-card">正在加载…</div></div>}>
      <LoginForm />
    </Suspense>
  );
}
