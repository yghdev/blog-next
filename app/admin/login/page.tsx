"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

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
export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

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
      router.push("/admin");
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
