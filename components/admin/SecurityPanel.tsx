"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

type SessionInfo = {
  id: string; userAgent: string; ip: string; createdAt: string;
  lastSeenAt: string | null; expiresAt: string; current: boolean;
  createdAtLabel: string; lastSeenLabel: string;
};

/* 每块是一个独立事务（账号 / 2FA / 设备 / 密码），各自动作即时生效，
   所以它们确实需要各自的边界 → 用 .card（后台的「独立模块」表面）。
   视觉全走 admin.css 的令牌，组件里不再写行内颜色。 */

/**
 * 按钮变体三选一，互斥。
 *
 * 刻意不用 primary + danger 组合：一个按钮既是「主操作」又是「危险操作」，
 * 等于用视觉重心把用户往破坏性动作上推（B 端门禁 06/11 明确禁止）。
 * 这里用 variant 单值，从类型上就堵死同时成立的可能。
 */
function Btn({ children, onClick, busy, variant = "default" }: {
  children: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
  variant?: "default" | "primary" | "danger";
}) {
  const cls = variant === "primary" ? "btn btn-sm btn-primary"
    : variant === "danger" ? "btn btn-sm btn-danger"
    : "btn btn-sm";
  return (
    <button className={cls} disabled={busy} onClick={onClick}>{children}</button>
  );
}

export function SecurityPanel({ username, totpEnabled, recoveryRemaining, sessions }: {
  username: string; totpEnabled: boolean; recoveryRemaining: number; sessions: SessionInfo[];
}) {
  const router = useRouter();
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // TOTP 绑定流程
  const [step, setStep] = useState<"idle" | "verify">("idle");
  const [secret, setSecret] = useState("");
  const [uri, setUri] = useState("");
  const [code, setCode] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

  // 改密
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  /* 两个高危动作要过确认弹窗：关掉 2FA 等于拆掉账号最后一道锁，
     退出所有设备会把包括当前在内的会话全部作废。 */
  const [confirming, setConfirming] = useState<null | "disable-totp" | "revoke-all">(null);

  const clear = () => { setMsg(""); setErr(""); };

  const start = async () => {
    clear(); setBusy(true);
    const res = await fetch("/api/admin/totp/start", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ totp: totpCode }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) { setSecret(d.secret); setUri(d.uri); setStep("verify"); }
    else setErr(d.error || "生成失败");
  };

  const confirm = async () => {
    clear(); setBusy(true);
    const res = await fetch("/api/admin/totp/confirm", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      setStep("idle"); setCode(""); setRecoveryCodes(d.recoveryCodes || []);
      setMsg("两步验证已启用，请立刻保存下面的恢复码");
      router.refresh();
    } else setErr(d.error || "验证失败");
  };

  const disable = async () => {
    clear(); setBusy(true);
    const res = await fetch("/api/admin/totp/disable", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ totp: totpCode }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) { setMsg("两步验证已关闭"); router.refresh(); }
    else setErr(d.status === 428 ? "需要先输入当前验证码" : d.error || "操作失败");
  };

  const regenRecovery = async () => {
    clear(); setBusy(true);
    const res = await fetch("/api/admin/recovery-codes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ totp: totpCode }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) { setRecoveryCodes(d.codes || []); setMsg("已生成新的恢复码，旧码全部作废"); router.refresh(); }
    else setErr(d.status === 428 ? "需要先输入当前验证码" : d.error || "操作失败");
  };

  const revoke = async (id: string, all = false) => {
    clear(); setBusy(true);
    const res = await fetch("/api/admin/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(all ? { action: "revoke_all" } : { action: "revoke", id }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      if (all) { window.location.href = "/admin/login"; return; }
      setMsg("已撤销该设备"); router.refresh();
    } else setErr(d.error || "操作失败");
  };

  const changePw = async () => {
    clear();
    if (newPassword.length < 12) { setErr("新密码至少 12 位"); return; }
    setBusy(true);
    const res = await fetch("/api/admin/password", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldPassword, newPassword, totp: totpCode }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      setMsg("密码已修改，所有设备需重新登录");
      setTimeout(() => { window.location.href = "/admin/login"; }, 1200);
    } else setErr(d.status === 428 ? "需要输入两步验证码" : d.error || "修改失败");
  };

  const needStepUpHint = totpEnabled ? (
    <div className="field fx-field-narrow">
      <label>当前两步验证码（敏感操作需要）</label>
      <input
        className="input"
        value={totpCode}
        onChange={(e) => setTotpCode(e.target.value)}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={12}
        placeholder="6 位数字或恢复码"
      />
    </div>
  ) : null;

  return (
    <>
      <section className="card">
        <h2 className="settings-group-title">账号</h2>
        <p className="settings-group-desc">当前账号：{username}</p>
        {msg ? <div className="notice notice-ok">{msg}</div> : null}
        {err ? <div className="notice notice-error">{err}</div> : null}
        {needStepUpHint}
      </section>

      <section className="card">
        <h2 className="settings-group-title">两步验证（TOTP）</h2>
        <p className="settings-group-desc">
          {totpEnabled
            ? "已启用。关闭它需要输入当前验证码 —— 这一点是刻意的：即使 Cookie 被窃也无法单方面关掉 2FA。"
            : "未启用。建议开启；开启后会生成 8 个恢复码，验证器丢失时可用来登录。"}
        </p>

        {step === "idle" && !totpEnabled ? <Btn onClick={start} busy={busy} variant="primary">启用</Btn> : null}
        {step === "idle" && totpEnabled ? (
          <Btn onClick={() => setConfirming("disable-totp")} busy={busy} variant="danger">关闭两步验证</Btn>
        ) : null}

        {step === "verify" ? (
          <div>
            <p className="settings-group-desc is-tight">
              1. 在验证器 App 里添加账号（手动输入下面的密钥）
            </p>
            <div className="fx-code-block">{secret}</div>
            <p className="fx-mono-note">{uri}</p>
            <p className="settings-group-desc is-tight">2. 输入 App 显示的 6 位验证码</p>
            <div className="fx-inline-row">
              <input
                className="input fx-input-narrow"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
              />
              <Btn onClick={confirm} busy={busy} variant="primary">确认</Btn>
            </div>
          </div>
        ) : null}

        {totpEnabled ? (
          <div className="settings-group-desc">
            剩余恢复码：<b>{recoveryRemaining}</b>
            <div className="fx-mt-2"><Btn onClick={regenRecovery} busy={busy}>重新生成恢复码</Btn></div>
          </div>
        ) : null}

        {recoveryCodes.length ? (
          <div className="fx-mt-4">
            <div className="notice notice-ok">
              这些恢复码只显示这一次，请立即保存到密码管理器。
            </div>
            <div className="fx-code-grid">
              {recoveryCodes.map((c) => <span key={c}>{c}</span>)}
            </div>
          </div>
        ) : null}
      </section>

      <section className="card">
        <h2 className="settings-group-title">已登录设备</h2>
        <p className="settings-group-desc">
          库里只存会话 token 的 SHA-256，所以这里显示的是哈希前缀，而非 token 本身。
        </p>
        {sessions.map((s) => (
          <div key={s.id} className="fx-session-row">
            <span className="fx-session-agent">
              {s.current ? <span className="fx-session-current" aria-label="当前设备">当前</span> : null}
              {s.userAgent}
            </span>
            <span className="fx-session-meta">{s.ip}</span>
            <span className="fx-session-meta">最近 {s.lastSeenLabel}</span>
            {s.current
              ? <span className="fx-session-meta">本机</span>
              : <Btn onClick={() => revoke(s.id)} busy={busy}>撤销</Btn>}
          </div>
        ))}
        <div className="fx-mt-3">
          <Btn onClick={() => setConfirming("revoke-all")} busy={busy} variant="danger">退出所有设备</Btn>
        </div>
      </section>

      <section className="card">
        <h2 className="settings-group-title">修改密码</h2>
        <p className="settings-group-desc">
          至少 12 位。修改成功后所有会话（含当前）都会失效，需要重新登录。
        </p>
        <div className="field">
          <label>当前密码</label>
          <input className="input" type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} autoComplete="current-password" />
        </div>
        <div className="field">
          <label>新密码</label>
          <input className="input" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
        </div>
        <Btn onClick={changePw} busy={busy} variant="primary">修改密码</Btn>
      </section>

      <ConfirmDialog
        open={confirming === "disable-totp"}
        title="关闭两步验证？"
        description={
          <>
            关闭后这个账号只剩密码一道防线，任何拿到密码的人都能直接进后台。
            这是不可逆的安全降级 —— 重新开启需要重新绑定验证器并保存新恢复码。
            <br />执行时会用到上方「当前两步验证码」。
          </>
        }
        confirmLabel="关闭两步验证"
        danger
        busy={busy}
        onCancel={() => setConfirming(null)}
        onConfirm={() => { setConfirming(null); void disable(); }}
      />

      <ConfirmDialog
        open={confirming === "revoke-all"}
        title="退出所有设备？"
        description={
          <>
            包括<strong>当前这台设备</strong>在内的全部会话会立即作废，你会被退回登录页。
            如果是怀疑账号泄露，这正是你要做的；只是想让手机下线，请用列表里对应的「撤销」。
          </>
        }
        confirmLabel="全部退出"
        danger
        busy={busy}
        onCancel={() => setConfirming(null)}
        onConfirm={() => { setConfirming(null); void revoke("", true); }}
      />
    </>
  );
}
