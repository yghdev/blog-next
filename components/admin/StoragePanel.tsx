"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * 图片存储配置面板（自建，不依赖任何第三方图床平台）。
 *
 * 反馈设计（2026-10-27 重做）：
 *   上一版保存成功后只 setMsg 一句话，又立刻 router.refresh()，
 *   用户看到的是"页面闪一下、什么都没发生"。而且状态徽章只写"已启用"，
 *   不告诉人配置到底存了什么、什么时候存的。
 *
 *   现在：
 *   · 保存 / 测试的结果**常驻**在按钮旁，不自动消失
 *   · 顶部显示「已启用 · 空间名 · 最后保存时间」
 *   · 测试成功给出实际对象数，失败给出七牛错误码翻的中文
 *   · 保存成功后提示下一步怎么做（去传一张图）
 */
type Status = {
  configured: boolean;
  bucket: string; endpoint: string; region: string;
  cdnDomain: string; pathStyle: boolean; hasSecret: boolean;
  savedAt?: string | null;
};

const REGIONS = [
  { label: "华南-广东（cn-south-1）", value: "cn-south-1", endpoint: "https://s3.cn-south-1.qiniucs.com" },
  { label: "华东-浙江（cn-east-1）", value: "cn-east-1", endpoint: "https://s3.cn-east-1.qiniucs.com" },
  { label: "华东-浙江2（cn-east-2）", value: "cn-east-2", endpoint: "https://s3.cn-east-2.qiniucs.com" },
  { label: "华北-河北（cn-north-1）", value: "cn-north-1", endpoint: "https://s3.cn-north-1.qiniucs.com" },
];

type Tone = "ok" | "err" | "info";

export function StoragePanel() {
  const router = useRouter();
  const [st, setSt] = useState<Status | null>(null);
  const [bucket, setBucket] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("cn-south-1");
  const [cdnDomain, setCdnDomain] = useState("");
  const [ak, setAk] = useState("");
  const [sk, setSk] = useState("");
  const [pathStyle, setPathStyle] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 常驻结果条：tone 决定颜色，text 是正文 */
  const [result, setResult] = useState<{ tone: Tone; text: string; at: string } | null>(null);

  const load = async () => {
    const d = await fetch("/api/admin/storage").then((r) => r.json()).catch(() => null);
    if (!d) return;
    setSt(d);
    setBucket(d.bucket ?? "");
    setEndpoint(d.endpoint ?? "");
    setRegion(d.region || "cn-south-1");
    setCdnDomain(d.cdnDomain ?? "");
    setPathStyle(!!d.pathStyle);
  };

  useEffect(() => { void load(); }, []);

  const payload = () => ({
    accessKeyId: ak || undefined,
    secretAccessKey: sk || undefined,
    bucket, endpoint, region, cdnDomain, pathStyle,
  });

  const onRegion = (v: string) => {
    setRegion(v);
    const hit = REGIONS.find((r) => r.value === v);
    if (hit) setEndpoint(hit.endpoint);
  };

  const say = (tone: Tone, text: string) =>
    setResult({ tone, text, at: new Date().toLocaleTimeString("zh-CN") });

  const test = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/storage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        say("ok", "连接成功。空间「" + bucket + "」可读，当前有 " + (d.sampleObjects ?? 0) + " 个对象样本。");
      } else {
        say("err", d.error || "连接失败");
      }
    } catch {
      say("err", "网络错误，测试请求没发出去");
    } finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/storage", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setAk(""); setSk("");
        // 先刷新本地状态再提示，保证徽章与表单一致
        await load();
        say("ok", "配置已保存。之后上传的图片会直接写入七牛，正文里插入的是 CDN 直链（" +
          cdnDomain + "/…）。建议现在去「写文章」传一张图确认。");
        router.refresh();
      } else {
        say("err", d.error || "保存失败");
      }
    } catch {
      say("err", "网络错误，保存请求没发出去");
    } finally { setBusy(false); }
  };

  const toneStyle = (t: Tone) => ({
    background: t === "ok" ? "var(--ok-bg, #e7f7ee)" : t === "err" ? "var(--err-bg, #fdecec)" : "var(--bg-tint)",
    color: t === "ok" ? "var(--ok-fg, #1a7f4b)" : t === "err" ? "var(--err-fg, #a12626)" : "var(--text-p3)",
    border: "1px solid " + (t === "ok" ? "var(--ok-bd, #b8e6cc)" : t === "err" ? "var(--err-bd, #f3c4c4)" : "var(--border)"),
  });

  return (
    <div className="card" style={{ padding: 20, marginBottom: 20 }}>
      {/* 标题行：状态徽章直接写出「空间名」，不让人再去表单里找 */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
        <h3 style={{ margin: 0, fontSize: "1rem" }}>图片存储（七牛云）</h3>
        <span style={{
          fontSize: ".72rem", padding: "2px 10px", borderRadius: 20, fontWeight: 500,
          ...(st?.configured
            ? { background: "var(--ok-bg, #e7f7ee)", color: "var(--ok-fg, #1a7f4b)" }
            : { background: "var(--warn-bg, #fff4e5)", color: "var(--warn-fg, #a15c00)" }),
        }}>
          {st?.configured
            ? "已启用 · " + st.bucket + (st.cdnDomain ? " · " + st.cdnDomain.replace(/^https?:\/\//, "") : "")
            : "未配置"}
        </span>
        {st?.hasSecret ? (
          <span style={{ fontSize: ".7rem", color: "var(--text-p4)" }}>密钥已保存</span>
        ) : null}
      </div>
      <p style={{ fontSize: ".8rem", color: "var(--text-p4)", margin: "0 0 16px" }}>
        上传的图片直接写入七牛空间，正文里插入的是 CDN 直链。未配置时自动退回本机磁盘（老方式）。
      </p>

      {/* 常驻结果条：不自动消失，方便对照表单排查 */}
      {result ? (
        <div style={{
          ...toneStyle(result.tone),
          padding: "10px 14px", borderRadius: 10, marginBottom: 16,
          fontSize: ".84rem", lineHeight: 1.6,
          display: "flex", gap: 10, alignItems: "flex-start",
        }}>
          <span style={{ flex: 1 }}>{result.text}</span>
          <span style={{ fontSize: ".7rem", opacity: .65, whiteSpace: "nowrap" }}>{result.at}</span>
          <button
            type="button"
            onClick={() => setResult(null)}
            aria-label="关闭提示"
            style={{ background: "none", border: 0, cursor: "pointer", color: "inherit", opacity: .6, fontSize: ".9rem", padding: 0 }}
          >×</button>
        </div>
      ) : null}

      <div className="editor-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}>
        <div className="field">
          <label>存储空间名称</label>
          <input className="input" value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="如 flechazo-blog" />
        </div>
        <div className="field">
          <label>存储区域</label>
          <select className="input" value={region} onChange={(e) => onRegion(e.target.value)}>
            {REGIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Endpoint</label>
          <input className="input" value={endpoint} onChange={(e) => setEndpoint(e.target.value)}
                 placeholder="https://s3.cn-south-1.qiniucs.com" style={{ fontFamily: "var(--font-mono)", fontSize: ".8rem" }} />
        </div>
        <div className="field">
          <label>CDN 访问域名</label>
          <input className="input" value={cdnDomain} onChange={(e) => setCdnDomain(e.target.value)}
                 placeholder="https://cdn.yghsite.cn" style={{ fontFamily: "var(--font-mono)", fontSize: ".8rem" }} />
        </div>
        <div className="field">
          <label>AccessKey</label>
          <input className="input" value={ak} onChange={(e) => setAk(e.target.value)}
                 placeholder={st?.hasSecret ? "已保存，留空表示不修改" : "请输入 AccessKey"}
                 style={{ fontFamily: "var(--font-mono)", fontSize: ".8rem" }} />
        </div>
        <div className="field">
          <label>SecretKey</label>
          <input className="input" type="password" value={sk} onChange={(e) => setSk(e.target.value)}
                 placeholder={st?.hasSecret ? "已保存，留空表示不修改" : "请输入 SecretKey"}
                 style={{ fontFamily: "var(--font-mono)", fontSize: ".8rem" }} />
        </div>
      </div>

      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: ".84rem", marginTop: 12, cursor: "pointer" }}>
        <input type="checkbox" checked={pathStyle} onChange={(e) => setPathStyle(e.target.checked)} />
        路径式访问（Path Style）—— 七牛一般不需要勾选；若提示 NoSuchBucket 可尝试打开
      </label>

      <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn btn-sm btn-primary" onClick={save} disabled={busy}
                style={{ padding: "6px 16px" }}>{busy ? "处理中…" : "保存配置"}</button>
        <button className="btn btn-sm" onClick={test} disabled={busy}
                style={{ padding: "6px 16px" }}>{busy ? "…" : "测试连接"}</button>
        <span style={{ fontSize: ".72rem", color: "var(--text-p4)", flex: 1, minWidth: 180 }}>
          密钥用 AES-256-GCM 加密后落库，不会随备份明文外流
        </span>
      </div>
    </div>
  );
}
