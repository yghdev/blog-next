"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * 图片存储配置面板（自建，不依赖任何第三方图床平台）。
 *
 * 设计取舍：
 *   · SK 永不回填到前端 —— 只显示「已保存」标记，改动时才输入新值
 *   · 「测试连接」用当前表单值，不需要先保存就能验证参数是否正确
 *   · 错误信息按七牛错误码翻译成人话（在 lib/qiniu.ts 里）
 */
type Status = {
  configured: boolean;
  bucket: string; endpoint: string; region: string;
  cdnDomain: string; pathStyle: boolean; hasSecret: boolean;
};

const REGIONS = [
  { label: "华南-广东（cn-south-1）", value: "cn-south-1", endpoint: "https://s3.cn-south-1.qiniucs.com" },
  { label: "华东-浙江（cn-east-1）", value: "cn-east-1", endpoint: "https://s3.cn-east-1.qiniucs.com" },
  { label: "华东-浙江2（cn-east-2）", value: "cn-east-2", endpoint: "https://s3.cn-east-2.qiniucs.com" },
  { label: "华北-河北（cn-north-1）", value: "cn-north-1", endpoint: "https://s3.cn-north-1.qiniucs.com" },
];

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
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/admin/storage").then((r) => r.json()).then((d: Status) => {
      setSt(d);
      setBucket(d.bucket ?? "");
      setEndpoint(d.endpoint ?? "");
      setRegion(d.region || "cn-south-1");
      setCdnDomain(d.cdnDomain ?? "");
      setPathStyle(!!d.pathStyle);
    }).catch(() => setErr("读取配置失败"));
  }, []);

  const payload = () => ({
    accessKeyId: ak || undefined,
    secretAccessKey: sk || undefined,
    bucket, endpoint, region, cdnDomain, pathStyle,
  });

  // 换区域时自动带出对应 endpoint（用户少填一个易错项）
  const onRegion = (v: string) => {
    setRegion(v);
    const hit = REGIONS.find((r) => r.value === v);
    if (hit) setEndpoint(hit.endpoint);
  };

  const test = async () => {
    setMsg(""); setErr(""); setBusy(true);
    try {
      const r = await fetch("/api/admin/storage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) setMsg("连接成功，空间可读（当前 " + (d.sampleObjects ?? 0) + " 个对象样本）");
      else setErr(d.error || "连接失败");
    } catch { setErr("网络错误，测试请求没发出去"); }
    finally { setBusy(false); }
  };

  const save = async () => {
    setMsg(""); setErr(""); setBusy(true);
    try {
      const r = await fetch("/api/admin/storage", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setMsg("已保存。之后上传的图片会直接写入七牛并返回 CDN 直链");
        setAk(""); setSk("");
        const s = await fetch("/api/admin/storage").then((x) => x.json()).catch(() => null);
        if (s) setSt(s);
        router.refresh();
      } else setErr(d.error || "保存失败");
    } catch { setErr("网络错误，保存请求没发出去"); }
    finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ padding: 20, marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
        <h3 style={{ margin: 0, fontSize: "1rem" }}>图片存储（七牛云）</h3>
        <span style={{
          fontSize: ".72rem", padding: "2px 8px", borderRadius: 20,
          background: st?.configured ? "var(--ok-bg, #e7f7ee)" : "var(--warn-bg, #fff4e5)",
          color: st?.configured ? "var(--ok-fg, #1a7f4b)" : "var(--warn-fg, #a15c00)",
        }}>{st?.configured ? "已启用" : "未配置"}</span>
      </div>
      <p style={{ fontSize: ".8rem", color: "var(--text-p4)", margin: "0 0 16px" }}>
        上传的图片直接写入七牛空间，正文里插入的是 CDN 直链。未配置时自动退回本机磁盘（老方式）。
      </p>

      {msg ? <div className="notice notice-ok" style={{ marginBottom: 12 }}>{msg}</div> : null}
      {err ? <div className="notice notice-error" style={{ marginBottom: 12 }}>{err}</div> : null}

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

      <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
        <button className="btn btn-sm btn-primary" onClick={save} disabled={busy}
                style={{ padding: "6px 16px" }}>{busy ? "处理中…" : "保存配置"}</button>
        <button className="btn btn-sm" onClick={test} disabled={busy}
                style={{ padding: "6px 16px" }}>测试连接</button>
        <span style={{ fontSize: ".72rem", color: "var(--text-p4)", alignSelf: "center", flex: 1, minWidth: 200 }}>
          密钥用 AES-256-GCM 加密后落库，不会随备份明文外流
        </span>
      </div>
    </div>
  );
}
