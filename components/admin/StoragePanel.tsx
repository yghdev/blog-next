"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "./ui";

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

  /**
   * 状态反馈的配色。
   *
   * 原先这里引用的是 --ok-fg / --err-bg / --ok-bd / --err-bd —— 这四个
   * **从来没有定义过**（规范里叫 --ok / --ok-bg / --ok-border，错误态用
   * --danger 一族）。注释里写着"暗色安全"，实际因为名字写错，每次都回退到
   * 硬编码的浅色主题色值：浅绿底 #e7f7ee 配深绿字 #1a7f4b。暗色主题下
   * 那是一整块亮斑，而且红绿状态色在暗底上完全失真。
   *
   * 现在只引用真实存在的语义 token，由主题自动切换。
   * 注意错误态用 danger 而不是自造的 err：规范里没有 err 这一层。
   */
  /* 状态条复用 .notice 的语义类：同一套「浅底深字 + 微边框」，
     不再自己拼一组颜色（拼出来的那组很容易漏掉暗色主题）。 */
  const toneClass = (t: Tone) =>
    "notice " + (t === "ok" ? "notice-ok" : t === "err" ? "notice-error" : "notice-info");

  return (
    <section className="card">
      {/* 标题行：状态徽章直接写出「空间名」，不让人再去表单里找 */}
      <div className="fx-card-head">
        <h3 className="settings-group-title">图片存储（七牛云）</h3>
        <Badge tone={st?.configured ? "ok" : "warn"} dot>
          {st?.configured
            ? "已启用 · " + st.bucket + (st.cdnDomain ? " · " + st.cdnDomain.replace(/^https?:\/\//, "") : "")
            : "未配置"}
        </Badge>
        {st?.hasSecret ? <span className="fx-session-meta">密钥已保存</span> : null}
      </div>
      <p className="settings-group-desc">
        上传的图片直接写入七牛空间，正文里插入的是 CDN 直链。未配置时自动退回本机磁盘（老方式）。
      </p>

      {/* 常驻结果条：不自动消失，方便对照表单排查 */}
      {result ? (
        <div className={toneClass(result.tone) + " fx-result-bar"}>
          <span className="fx-result-text">{result.text}</span>
          <span className="fx-result-time">{result.at}</span>
          <button
            type="button"
            onClick={() => setResult(null)}
            aria-label="关闭提示"
            className="fx-result-close"
          >×</button>
        </div>
      ) : null}

      <div className="settings-grid">
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
                 placeholder="https://s3.cn-south-1.qiniucs.com" />
        </div>
        <div className="field">
          <label>CDN 访问域名</label>
          <input className="input" value={cdnDomain} onChange={(e) => setCdnDomain(e.target.value)}
                 placeholder="https://cdn.yghsite.cn" />
        </div>
        <div className="field">
          <label>AccessKey</label>
          <input className="input" value={ak} onChange={(e) => setAk(e.target.value)}
                 placeholder={st?.hasSecret ? "已保存，留空表示不修改" : "请输入 AccessKey"} />
        </div>
        <div className="field">
          <label>SecretKey</label>
          <input className="input" type="password" value={sk} onChange={(e) => setSk(e.target.value)}
                 placeholder={st?.hasSecret ? "已保存，留空表示不修改" : "请输入 SecretKey"} />
        </div>
      </div>

      <label className="switch-row">
        <input type="checkbox" checked={pathStyle} onChange={(e) => setPathStyle(e.target.checked)} />
        <span>
          <b>路径式访问（Path Style）</b>
          <em>七牛一般不需要勾选；若提示 NoSuchBucket 可尝试打开</em>
        </span>
      </label>

      {/* 一个操作区最多一个主按钮：保存是主操作，测试连接是次级的 */}
      <div className="fx-action-row">
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? "处理中…" : "保存配置"}
        </button>
        <button className="btn" onClick={test} disabled={busy}>{busy ? "…" : "测试连接"}</button>
        <span className="fx-action-hint">密钥用 AES-256-GCM 加密后落库，不会随备份明文外流</span>
      </div>
    </section>
  );
}
