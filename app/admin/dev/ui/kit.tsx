"use client";
import { useState } from "react";
import { Card, Empty, Badge, Notice, Figure, State, SectionHead, EmptyLine } from "@/components/admin/ui";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Field, TextInput, TextArea } from "@/components/ui/Field";
import { Skeleton, SkeletonText, SkeletonRows } from "@/components/ui/Skeleton";
import { Tabs, TabPanel } from "@/components/ui/Tabs";
import { StatBar } from "@/components/ui/StatBar";
import { DataTable } from "@/components/ui/DataTable";
import { ToastViewport, useToasts } from "@/components/ui/Toast";

/**
 * 对照页内容。覆盖方案 §10 阶段 01-A 要求的状态矩阵：
 * 空 / 加载 / 错误 / 禁用 / 长文本 / 双主题 / 窄屏。
 *
 * 双主题与窄屏不用专门的开关：主题跟随站点现有的切换按钮与系统偏好，
 * 窄屏用浏览器宽度即可（这里不伪造媒体查询，否则测的不是真实行为）。
 */
export function UiKit() {
  const [tab, setTab] = useState("posts");
  const [note, setNote] = useState("");
  const toasts = useToasts();

  return (
    <>
      <ToastViewport items={toasts.items} onDismiss={toasts.dismiss} />

      <Card title="Button" desc="一个操作区最多一个 primary；danger 是浅底深字，不做主色铺红。">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          <Button variant="primary">发布</Button>
          <Button>存为草稿</Button>
          <Button variant="danger">移入回收站</Button>
          <Button variant="ghost">取消</Button>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          <Button size="sm">小号</Button>
          <Button size="sm" variant="danger">小号危险</Button>
          <Button loading>正在发布</Button>
          <Button disabled>不可用</Button>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <ButtonLink href="/admin" variant="ghost" size="sm">跳转型按钮</ButtonLink>
        </div>
      </Card>

      <Card title="Field" desc="标签真绑定、错误用 aria-describedby 关联，且文案带「错误：」前缀，不只靠颜色。">
        <Field id="demo-title" label="标题" required hint="草稿可以先不填，发布时会要求。">
          <TextInput id="demo-title" defaultValue="一篇很长的标题，用来验证在窄屏下是否会挤压右侧操作区而不是把按钮顶出屏幕" />
        </Field>
        <Field id="demo-slug" label="URL 路径" error="该路径已被其他文章占用">
          <TextInput id="demo-slug" defaultValue="taken" invalid />
        </Field>
        <Field id="demo-body" label="正文" hint="Markdown 原文，保存前后逐字节一致。">
          <TextArea id="demo-body" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="随便输点东西，验证输入不会丢焦点" />
        </Field>
        <Field label="禁用态">
          <TextInput disabled defaultValue="不可编辑" />
        </Field>
      </Card>

      <Card title="Skeleton" desc="形状贴合最终内容，切换时不跳动。减弱动效下不闪烁。">
        <div style={{ display: "grid", gap: 18 }}>
          <SkeletonText lines={3} />
          <SkeletonRows rows={3} />
        </div>
      </Card>

      <Card title="Tabs" desc="只有真正切换面板才用 role=tab。筛选请用 aria-pressed / aria-current。">
        <Tabs
          ariaLabel="内容类型"
          value={tab}
          onChange={setTab}
          items={[
            { id: "posts", label: "文章" },
            { id: "pages", label: "页面" },
            { id: "shuoshuo", label: "说说" },
            { id: "disabled", label: "不可用", disabled: true },
          ]}
        />
        <TabPanel id="posts" value={tab}>文章面板。键盘左右箭头可切换，Home/End 到首尾。</TabPanel>
        <TabPanel id="pages" value={tab}>页面面板。</TabPanel>
        <TabPanel id="shuoshuo" value={tab}>说说面板。</TabPanel>
      </Card>

      <Card title="StatBar" desc="构成类指标。每段都有文字，读屏整条念一句，不逐个念空 div。">
        <StatBar
          ariaLabel="文章状态分布"
          segments={[
            { label: "已发布", value: 31, tone: "ok" },
            { label: "草稿", value: 7, tone: "warn" },
            { label: "回收站", value: 2, tone: "danger" },
          ]}
        />
        <div style={{ height: 18 }} />
        <StatBar
          ariaLabel="空数据"
          segments={[
            { label: "已发布", value: 0, tone: "ok" },
            { label: "草稿", value: 0, tone: "warn" },
          ]}
        />
      </Card>

      <Card title="DataTable" desc="div + ARIA role 保留表格语义；≤820px 折成两行卡片。">
        <div style={{ display: "grid", gap: 12 }}>
          <DataTable
            columns={[
              { key: "title", header: "标题", grow: true },
              { key: "status", header: "状态" },
              { key: "date", header: "更新时间", numeric: true },
            ]}
            rows={[
              { id: "1", title: "这是一篇标题相当长的文章，用来验证 grow 列会省略而不是把日期挤出屏幕", status: "已发布", date: "10-27" },
              { id: "2", title: "短标题", status: "草稿", date: "10-26" },
            ]}
            rowKey={(r) => r.id}
            render={(r, col) => {
              if (col.key === "status") return <Badge tone={r.status === "已发布" ? "ok" : "warn"}>{r.status}</Badge>;
              if (col.key === "date") return r.date;
              return r.title;
            }}
          />
          <DataTable
            columns={[{ key: "a", header: "加载中", grow: true }, { key: "b", header: "数量", numeric: true }]}
            rows={[]}
            rowKey={() => 0}
            loading
            loadingRows={3}
            render={() => null}
          />
          <DataTable
            columns={[{ key: "a", header: "空态", grow: true }]}
            rows={[]}
            rowKey={() => 0}
            empty={<Empty title="还没有内容" hint="写下第一篇，或者检查内容类型筛选是否把结果挡住了。" />}
            render={() => null}
          />
        </div>
      </Card>

      <Card title="Toast" desc="成功短、错误长；悬停或聚焦时暂停计时。手机端贴底并避让安全区。">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button size="sm" onClick={() => toasts.push("ok", "已保存")}>成功</Button>
          <Button size="sm" onClick={() => toasts.push("info", "正在同步存储统计")}>信息</Button>
          <Button size="sm" onClick={() => toasts.push("warn", "本地草稿保存失败，请导出备份")}>警告</Button>
          <Button size="sm" variant="danger" onClick={() => toasts.push("danger", "发布失败：服务端草稿版本已变化，请先核对")}>错误</Button>
        </div>
      </Card>

      <Card title="Badge 与 Notice" desc="浅底深字，必须带业务文案，禁止彩虹配色。">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          <Badge>中性</Badge>
          <Badge tone="ok" dot>已发布</Badge>
          <Badge tone="warn" dot>草稿</Badge>
          <Badge tone="danger" dot>已删除</Badge>
          <Badge tone="info">12 条</Badge>
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          <Notice kind="ok">保存成功</Notice>
          <Notice kind="warn">本地草稿未能写入，已提示导出</Notice>
          <Notice kind="error">URL 路径已被占用</Notice>
          <Notice kind="info">自动保存已关闭，手动保存仍可用</Notice>
        </div>
      </Card>

      <Card title="State 与 Badge 的分工" desc="列表行里的状态用 State（圆点 + 文案，不铺底）；Badge 只给需要跳出视线的少量信息。每行都挂胶囊会变成一条彩虹。">
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
          <State status="published" />
          <State status="draft" />
          <State status="trash" />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Badge>中性</Badge>
          <Badge tone="ok" dot>已发布</Badge>
          <Badge tone="warn" dot>草稿</Badge>
          <Badge tone="danger" dot>已删除</Badge>
          <Badge tone="info">12 条</Badge>
          <Badge tone="accent">置顶</Badge>
        </div>
      </Card>

      <Card title="列表行（留白 + 细线，没有卡片）" desc="行内操作默认隐藏，悬停或键盘聚焦时出现；(hover:none) 设备上常显 —— 手机不能依赖 hover。">
        <SectionHead title="未发布草稿" action={<a href="/admin?status=draft">全部草稿</a>} />
        <div className="work-list">
          <a className="work-item" href="/admin/new">
            <span className="work-item-title">把博客从 WordPress 搬到 SQLite 的这三个月</span>
            <State status="draft" />
            <span className="work-item-date">10-27</span>
          </a>
          <a className="work-item" href="/admin/new">
            <span className="work-item-title">一篇标题非常长的文章，用来验证行内省略号生效而不是把日期和状态挤出屏幕</span>
            <span className="work-item-date">10-26</span>
          </a>
        </div>
        <EmptyLine>没有更多内容了。<a href="/admin/new">开一篇新的</a></EmptyLine>
      </Card>

      <Card title="数据行 + 批量条" desc="批量条只在选中后出现；它浮在列表上方，是这张页面上唯一允许有影子的东西。">
        <div className="bulk-bar">
          <span className="fx-bulkbar-count">已选 2 项</span>
          <span className="bulk-bar-fill" />
          <Button size="sm">发布</Button>
          <Button size="sm">转草稿</Button>
          <Button size="sm" variant="danger">移入回收站</Button>
          <Button size="sm" variant="ghost">取消选择</Button>
        </div>
        <div className="data-panel">
          <div className="data-row is-selected">
            <input type="checkbox" defaultChecked aria-label="选择第一项" />
            <span className="content-type">文</span>
            <State status="published" />
            <a className="data-row-title" href="/admin/new">霍夫变换到底在做什么</a>
            <span className="data-row-meta">2026-10-27</span>
            <span className="fx-row-actions"><Button size="sm" variant="ghost">编辑</Button></span>
          </div>
          <div className="data-row">
            <input type="checkbox" aria-label="选择第二项" />
            <span className="content-type">页</span>
            <State status="draft" />
            <a className="data-row-title" href="/admin/new">关于我</a>
            <span className="data-row-meta">未发布</span>
            <span className="fx-row-actions"><Button size="sm" variant="ghost">编辑</Button></span>
          </div>
        </div>
      </Card>

      <Card title="Figure 与空状态">
        <div className="fx-figure-row" role="group" aria-label="内容概况">
          <Figure label="未发布草稿" value={7} href="/admin" alert />
          <Figure label="待审评论" value={3} href="/admin/comments" />
          <Figure label="已发布" value={31} />
          <Figure label="回收站" value={2} />
        </div>
        <Empty
          title="这里还没有内容"
          hint="说明为什么为空，并给一个能继续走的动作，而不是只留一句「暂无数据」。"
          actions={<ButtonLink href="/admin/new" variant="primary" size="sm">写第一篇</ButtonLink>}
        />
      </Card>

      <Card title="品牌标识与危险操作区" desc="品牌只有「衬线 wordmark + 一枚赤陶方点」，全站就这一处固定装饰。危险操作单独成区并自带确认。">
        <div style={{ marginBottom: 16 }}>
          <a className="fx-brandmark" href="/admin">flechazo</a>
          <span className="fx-brand-sub">妄司逸的小世界</span>
        </div>
        <div className="danger-zone">
          <h3 className="danger-zone-title">删除全部草稿</h3>
          <p className="danger-zone-desc">
            这里只是危险区样式的示例。真实场景里这个动作会走 ConfirmDialog，并在描述里写清连带影响。
          </p>
          <Button size="sm" variant="danger">删除全部草稿</Button>
        </div>
      </Card>
    </>
  );
}
