# 博客前端改版 · 代码审查报告

> 审查对象：`blog-next`（master，HEAD `07519eb`）
> 审查时间：2026-10-31
> 审查范围：前台（首页 / 说说 / 归档 / 友链 / 关于 / 文章）的布局、组件、样式、主题、日期处理
> 审查方式：只读。**未修改任何源码，未新建组件/路由**。
> 结论来源：逐文件阅读 + 隔离库启动 standalone 实测（Playwright 测量）+ `tsc --noEmit` + `tests/time.test.ts`。

---

## 0. 结论速览

1. **必须先修的 5 件事**（与视觉改版解耦，可独立提交）：
   - 归档 1–9 月显示 `NaN 月`（`lib/posts.ts` + `lib/time.ts`）
   - 归档月份排序错乱（10 月被排到最后）
   - 空/非法日期产生空年份分组与 `0 月`
   - 右栏 `max-height + overflow-y` 造成独立滚动，与页面抢滚轮
   - `globals.css` 里 reduced-motion 全局块被注释吞掉（缺 `*/`）
2. **布局不是「全局布局 + 页面」**，而是 6 处复制粘贴的 `<div className="site-shell">`（另有友链页 1 处变体），友链页再覆盖 3 个属性。改版前应先收敛骨架，否则每个改动要改 7 遍。
3. **右侧栏双滚动条的根因只有一行 CSS**：`.toc-col { max-height: calc(100vh - 96px); overflow-y: auto }`。不是浏览器问题，也不是 sticky 失效。
4. **友链页的「独立布局」是全站耦合最重的地方**：左栏横向错位（1440px 下 32px vs 76px）、双页脚、断点要维护 3 份、测试写死「本页无右栏」。
5. **主题系统本身完整**（三态 + 防闪烁 + Artalk 同步），但令牌重复两份、缺 `color-scheme`、多实例状态不同步。
6. **已存在 58 个设计 token，全部零引用**（`globals.css:1883-1979`）。改版时不要再往上加，先决定清理还是启用。
7. **后台与前台共享 `.btn/.input/.notice/.badge/.dialog/.empty-block`**，前台改版的最大隐性风险在后台；任何原子类改动都要跑后台三套测试。

---

## 1. 技术栈与项目结构

### 1.1 技术栈（已核对 `package.json` 与 `node_modules` 实际版本）

| 项 | 实际情况 |
| --- | --- |
| 框架 | Next.js **16.4.2**，App Router，`output: "standalone"`（`next.config.ts`） |
| React | 19.3.1 |
| 数据 | SQLite + better-sqlite3 12.11.1，表结构唯一来源 `lib/migrations.ts` |
| 样式 | **手写 CSS + CSS 变量**：`app/globals.css` 1990 行、`app/friend-links/friends.css` 890 行、`app/admin/admin.css` 5276 行 |
| Tailwind | 装了 `tailwindcss@4.3.3` + `@tailwindcss/postcss`，`globals.css:1` 有 `@import "tailwindcss"`，但 TSX 中 682 个 class token **0 个是 Tailwind 工具类**（全量扫描）。实际只用到了 Preflight 重置，工具类能力完全未使用 |
| Markdown | marked 15.0.12，`lib/markdown.ts`（含 TOC 提取 `renderMarkdown`） |
| 评论 | Artalk 客户端嵌入，`components/CommentSection.tsx` |
| 测试 | node:test + Playwright，`tests/*.test.ts` / `tests/*.mjs` |

### 1.2 前台目录骨架

```
app/
  layout.tsx              根布局：主题脚本、移动顶栏、侧栏抽屉 Provider、全站页脚、访客埋点
  page.tsx                首页（文章列表）
  [slug]/page.tsx         旧地址兼容层 + 页面类（/about 等）渲染入口
  p/[id]/page.tsx         文章规范地址 /p/<id>
  archives/page.tsx       归档
  shuoshuo/page.tsx       说说
  friend-links/page.tsx   友链专题页（独立布局）
  friend-links/friends.css
  search/page.tsx         搜索
  tags/[tag]/page.tsx     标签
  not-found.tsx / robots.ts / sitemap.ts / rss.xml / manifest.ts
  globals.css

components/
  Sidebar / MobileNav / MobileSidebar / SidebarSheet / RightBar / SiteFooter
  PostCard / FriendLinks / SearchBox / ThemeToggle / ThemeScript / Animations / ScrollReset
  ArticleView / CommentSection / Lightbox / FrontOnly / VisitorBeacon / PwaRegister / MobileKeyboardGuard
  friends/{FriendCard,SiteAvatar,CopyFriendConfig,JumpToComments}
  ui/{Button,Field,Skeleton,Tabs,StatBar,DataTable,Toast,ConfirmDialog,BottomSheet,useScrollLock}

lib/
  posts.ts（含 listArchives）    time.ts（日期基准）
  cached.ts（unstable_cache 包装） friend-links*.ts
  settings.ts    db.ts    migrations.ts    markdown.ts    search.ts
```

### 1.3 渲染模型

- 前台页面**全部 `export const dynamic = "force-dynamic"`**，不做整页 ISR。
- 只对数据读取做 `unstable_cache`（`lib/cached.ts`，TTL 300s，`revalidateTag` 精准失效）。
- 原因写在 `lib/cached.ts:1-28`：构建机上没有线上库，ISR 会把开发库内容冻进产物。

---

## 2. 全局布局与左侧导航

### 2.1 布局不是由 layout 统一控制

`app/layout.tsx` 只负责「页面以外的东西」：

- `<html lang="zh-CN" suppressHydrationWarning>` + `<body>`
- `ThemeScript`（防闪烁内联脚本）
- `ScrollReset`（路由变化回顶）
- `SidebarSheetProvider panel={<MobileSidebarContent />}`（右栏抽屉）
- `FrontOnly` 包裹的 `MobileNav`、`SiteFooter`、`VisitorBeacon`
- `PwaRegister`、`MobileKeyboardGuard`

真正的骨架由**每个页面自己拼装**：`site-shell` 这一层重复 6 处（其中搜索页只声明了网格、没有第三列子元素），友链页是第 7 处变体（两栏，且改写了网格）。

```tsx
<div className="site-shell">
  <Sidebar active="/xxx" />
  <main className="content">…</main>
  <div className="toc-col"><RightBar /></div>
</div>
```

出现位置：

| 文件 | 行 | 结构 |
| --- | --- | --- |
| `app/page.tsx` | 23-68 | 三栏完整 |
| `app/archives/page.tsx` | 21-59 | 三栏完整 |
| `app/shuoshuo/page.tsx` | 16-40 | 三栏完整 |
| `app/search/page.tsx` | 27-89 | **声明三栏但没有 `toc-col` 子元素** |
| `app/tags/[tag]/page.tsx` | 26-47 | 三栏完整 |
| `components/ArticleView.tsx` | 70-148 | 三栏完整 |
| `app/friend-links/page.tsx` | 128-337 | `site-shell fr-shell`，无 `toc-col` |

### 2.2 三栏 CSS（`globals.css:178-196`）

```css
.site-shell {
  display: grid;
  grid-template-columns: var(--w-side) minmax(0, var(--w-main)) var(--w-toc);
  gap: var(--gap-col);
  max-width: calc(var(--w-side) + var(--w-main) + var(--w-toc) + var(--gap-col) * 2 + 64px);
  margin: 0 auto;
  padding: 48px 32px 96px;
  align-items: start;
}
.sidebar {
  position: sticky;
  top: 40px;
  display: flex;
  flex-direction: column;
  align-self: start;
}
```

令牌（`globals.css:32-35`）：`--w-main: 800px; --gap-col: 40px; --w-side: 288px; --w-toc: 320px;`

### 2.3 断点

| 断点 | 行为 | 位置 |
| --- | --- | --- |
| `≤1200px` | 删掉右栏列 `grid-template-columns: var(--w-side) minmax(0, 1fr)`，`.toc-col { display: none }` | `globals.css:765-771` |
| `≤820px` | `.sidebar { display: none }`，`.mobile-topbar { display: flex }`，单列，`padding: 14px 20px calc(72px + env(safe-area-inset-bottom))` | `globals.css:773-799` |
| `821–1200px` | 右栏没了、顶栏还没有 → 用 `.side-sheet-entry`（左栏底部）+ `SidebarSheet` 抽屉补位 | `Sidebar.tsx:49-52`、`globals.css:1090-1121` |
| `≥1201px` | `.side-sheet-entry { display: none }` | `globals.css:1119-1121` |

**实测布局数值（1440×900）**：`288px / 688px / 320px`，`.content` 宽 688px，`.sidebar.left = 32px`。

**断崖问题（实测）**：

| 视口宽 | 列模板 | `.content` 宽 |
| --- | --- | --- |
| 1200 | `288px 760px` | 760px |
| **1201** | `288px 449px 320px` | **449px** ← 骤降 311px |
| 1220 | `288px 468px 320px` | 468px |
| 1366 | `288px 614px 320px` | 614px |
| 1440 | `288px 688px 320px` | 688px |
| 1600 | `288px 800px 320px` | 800px（居中 24px 边距） |

原因：1200 断点关掉右栏但主栏上限仍是 `--w-main: 800px`，1201 处三列挤在一起，中栏被压到 449px。这是改版必须处理的断崖。

### 2.4 左侧导航

`components/Sidebar.tsx`：

- 品牌区：`/avatar.jpg`（88px 圆图）+ `flechazo` + 简介（20-23 行，**硬编码**）
- `NAV` 数组（5-11 行）
- `nav-item`：图标 + 文字 + active 圆点
- 平板侧栏入口 `.side-sheet-entry`（49-52 行）
- 主题切换 `.side-theme`（55-57 行）
- 底部 RSS / 设置（59-62 行）

`active` 是**手工字符串 prop**，不是 `usePathname()`：

| 页面 | 传入值 | 结果 |
| --- | --- | --- |
| 首页 | `"/"` | ✅ 文章 |
| 说说 / 归档 / 友链 | 对应路径 | ✅ |
| 标签页 | `""` | ❌ 无选中 |
| 搜索页 | `"/search"` | ❌ `NAV` 里没有 `/search`，无选中 |
| `/about` | `""`（`ArticleView.tsx:71` 三元） | ❌ 无选中 |

### 2.5 选中态样式实际未完全生效

`globals.css` 里有两代导航样式并存：

```css
/* 204-212：旧写法，特异性 (0,1,1) */
.nav a { padding: 6px 10px; border-radius: 8px; font-size: .925rem; }
.nav a.active { color: var(--text-p0); font-weight: 600; background: var(--bg-subtle); }

/* 1048-1087：新写法，特异性 (0,1,0) */
.nav-item { padding: 13px 16px; border-radius: 13px; font-size: .95rem; ... }
```

`.nav a` 特异性更高 → **新的 padding / 圆角 / 字号从未生效**。

实测（1440×900）：

```
nav-item 计算样式: padding 6px 10px, border-radius 8px, font-size 14.8px, 行高 43px
设计意图（.nav-item）: padding 13px 16px, border-radius 13px, 行高 ≈48px
图标左缘: 非选中 135px / 选中 126px（选中项因圆点让内容整体左移 9px）
```

---

## 3. 五个页面对应的组件和文件

| 页面 | 路由文件 | 使用组件 | 数据来源 |
| --- | --- | --- | --- |
| 首页 | `app/page.tsx` | `Animations`、`Sidebar`、`SearchBox`（dashed）、`PostCard`、`RightBar` | `listPostsCached / countPostsCached / getViewsMapCached` |
| 说说 | `app/shuoshuo/page.tsx` | `Sidebar`、`RightBar`、`formatDate`（**从 `PostCard` 导出**） | `listShuoshuoCached(100)`、`renderMarkdown(s.content).html` |
| 归档 | `app/archives/page.tsx` | `Sidebar`、`RightBar`、`dateKeyIn` | `listArchivesCached()` → `lib/posts.ts:148-174` |
| 友链 | `app/friend-links/page.tsx` | `Sidebar`、`FriendCard`、`SiteAvatar`、`CopyFriendConfig`、`JumpToComments`、`CommentSection`，样式 `friends.css` | `loadFriendLinksPage()`、`listFriendLinksCached()`、`getSettings()` |
| 关于 | **无独立文件**，走 `app/[slug]/page.tsx` → `components/ArticleView.tsx` | `Sidebar`、`RightBar(toc)`、`CommentSection`、`Lightbox` | `posts` 表 `type=page, slug=about`；种子 `content/pages/about.md` |
| （文章） | `app/p/[id]/page.tsx` → `ArticleView` | 同上 | `getPostByIdCached` |

### 3.1 `/about` 的数据来源与隐患

- 路由：`app/[slug]/page.tsx` 中 `resolveSlugCached(slug)` 命中 `type=page` → 原地渲染 `ArticleView`。
- 正文种子：`content/pages/about.md`。
- **只有 `scripts/migrate-wp.mjs:117-131` 会导入 `content/pages/*.md`；`scripts/init-db.mjs` 不导入任何页面** → 全新安装的库 `/about` 直接 404。
- `/friend-links` 有兜底（`lib/friend-links-page-source.ts` 读种子文件），`/about` 没有。
- 实测：插入 `type=page, slug=about` 后 `/about` 返回 200，`article-title` = "关于"，`toc-list` 有 2 条。

### 3.2 组件依赖细节

- `PostCard.tsx` 同时导出 `PostCard` / `toIso` / `formatDate` —— 说说页为了拿 `formatDate`，从卡片组件里 import，耦合不合理。
- `app/tags/[tag]/page.tsx:5` import 了 `getDb` 但未使用；`lib/posts.ts:2` import 了 `dateKeyIn` 但未使用；`app/layout.tsx:13` import 了 `ThemeToggle` 但未使用；`components/friends/CopyFriendConfig.tsx:3` import 了 `SiteAvatar` 但未使用。

---

## 4. 右侧边栏实现与双滚动条根因

### 4.1 桌面实现

`components/RightBar.tsx`（服务端组件）：

1. 目录（可选，`toc` prop，仅文章/页面传）
2. 站点统计 `.stat-grid`（2 列，4 项：文章/说说/评论/运行）
3. `<FriendLinks />`（聚合 hub + 友链 friend）
4. 标签云 `.tag-cloud`

容器由页面提供：`<div className="toc-col"><RightBar /></div>`。

### 4.2 移动/平板实现

`components/MobileSidebar.tsx` **重写了一遍相同的四个区块**（统计 / 聚合 / 友链 / 标签云），由 `components/SidebarSheet.tsx` 用 `createPortal(..., document.body)` 渲染成右侧抽屉。

两份实现的数据来源相同（都走 `lib/cached.ts`），但 JSX 结构是复制粘贴。

### 4.3 双滚动条根因（`globals.css:547-553`）

```css
.toc-col {
  position: sticky;
  top: 48px;
  align-self: start;
  max-height: calc(100vh - 96px);   /* ← 根因 1 */
  overflow-y: auto;                  /* ← 根因 2 */
}
```

右栏内容随友链数量线性增长，很容易超过视口高度，于是：

- 右栏自己出现一条滚动条（`overflow-y: auto`）
- 页面还有一条滚动条
- 鼠标在右栏区域时滚轮只滚右栏，在正文区域时只滚页面 → 「两个滚动区域争夺滚轮」

**实测证据**（1440×800，插入 18 条友链 + 4 个聚合）：

```json
{
  "tocOverflowY": "auto",
  "colClientH": 704,
  "colScrollH": 1647,
  "colScrollable": true,
  "docScrollH": 3629,
  "wheelInRightBar": { "pageY": 0, "tocScrollTop": 600 }
}
```

全页可滚动容器扫描结果：`[{ "cls": "toc-col", "h": 704, "sh": 1647 }]` —— 唯一的嵌套滚动容器就是右栏。

### 4.4 其它加剧因素

1. `max-height` 用 `100vh` 而非 `100dvh`：移动浏览器地址栏收放时高度跳变。同文件其它浮层已改 `100dvh`（`globals.css:871`、`1204`），此处遗漏。
2. 只有「目录」需要跟随滚动，但 `max-height + overflow` 套在**整列**上，把统计 / 友链 / 标签云一起变成了独立滚动区。
3. `body { overflow-x: hidden }`（`globals.css:159`）让 body 成为滚动上下文，模糊了「谁是滚动主体」。当前 `html` 与 `body` 的 `scrollHeight` 一致（实测 3629），尚未出现第二条可见滚动条，但属于同类隐患。
4. `.sidebar` sticky `top: 40px`，`.toc-col` sticky `top: 48px` —— 同屏两条基线不齐（实测滚动后 40 / 48）。

### 4.5 修正方向

- 去掉 `.toc-col` 的 `max-height / overflow-y`，右栏整体跟随页面滚动（默认行为）。
- 若目录过长，只给目录列表加 `position: sticky; max-height: calc(100dvh - Xpx); overflow-y: auto; overscroll-behavior: contain`。
- 用 `--sticky-top` 统一 `.sidebar` 与 `.toc-col` 的吸顶基线。

---

## 5. 归档页 NaN 月根因（已复现）

### 5.1 代码链路

**① `lib/time.ts:74-80`**

```ts
export function dateKeyIn(value, tz = DISPLAY_TZ): string {
  const p = fmt("date", tz).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return g("year") + "-" + g("month") + "-" + g("day");
}
```

`fmt()` 在 `lib/time.ts:54` 用的是 `{ year: "numeric", month: "numeric", day: "numeric" }` —— **`numeric` 不补零**。

**② `lib/posts.ts:159`**

```ts
const ym = monthKeyIn(ts);   // = dateKeyIn(...).slice(0, 7)
```

**③ `lib/posts.ts:171`**

```ts
.map(([ym, posts]) => ({ ym, label: Number(ym.slice(5, 7)) + " 月", posts }));
```

**④ `app/archives/page.tsx:44`** 渲染 `{m.label}`

### 5.2 复现结果（Node，`DISPLAY_TZ=Asia/Shanghai`）

| 发布时间（UTC） | `dateKeyIn` | `ym = slice(0,7)` | `slice(5,7)` | label |
| --- | --- | --- | --- | --- |
| 2026-08-05T02:00Z | `2026-8-5` | `2026-8-` | `"8-"` | **NaN 月** |
| 2026-09-08T02:00Z | `2026-9-8` | `2026-9-` | `"9-"` | **NaN 月** |
| 2026-10-29T02:00Z | `2026-10-29` | `2026-10` | `"10"` | `10 月` ✅ |
| 2026-01-03T02:00Z | `2026-1-3` | `2026-1-` | `"1-"` | **NaN 月** |

### 5.3 端到端验证

隔离库插入上述 4 篇文章，请求 `/archives`，实际 HTML：

```html
<div style="...margin:6px 0 4px">NaN 月</div>   <!-- 9 月 -->
<div style="...margin:6px 0 4px">NaN 月</div>   <!-- 8 月 -->
<div style="...margin:6px 0 4px">10 月</div>
<div style="...margin:6px 0 4px">NaN 月</div>   <!-- 1 月 -->
```

**结论：所有 1–9 月的文章都会变成 `NaN 月`，10–12 月正常。** 这与截图中「多处 NaN 月」完全吻合。

### 5.4 同一根因带出的 3 个次生问题

**（1）月份排序错乱**

`ym` 本身是 `2026-8-` / `2026-9-` 形态，`localeCompare` 降序结果：

```js
['2026-10', '2026-8-', '2026-9-'].sort((a, b) => b.localeCompare(a))
// => ['2026-9-', '2026-8-', '2026-10']   ← 10 月被排到最后
```

实测页面顺序：9 月 → 8 月 → 10 月 → 1 月，**10 月（最新）排在最后**。
年份排序不受影响（`2026` 仍是 4 位）。

**（2）空/非法日期进入分组，产生 `0 月`**

`lib/posts.ts:155-164` 没有过滤空 key：

```js
dateKeyIn("garbage")        // => ""
yearKeyIn("garbage")        // => ""
monthKeyIn("garbage")       // => ""
label = Number("".slice(5,7)) + " 月"  // => "0 月"
```

即：一条脏数据会产生一个 `year=""` 的空年份分组 + `0 月` 标签。

**（3）反向日期解析依赖运行时 TZ**

`dateKeyIn` 的输出被当作日期字符串再喂回 `toUtcIso()`（例如 `lib/search.ts:48` 的 `date` 字段 → `PostCard.formatDate`）。`"2026-8-5"` 不匹配 `lib/time.ts:27` 的 `NAIVE` 正则（要求两位月份），落到 `new Date("2026-8-5")` 宽松解析：

| 运行时 TZ | `toUtcIso("2026-8-5")` | 显示结果 |
| --- | --- | --- |
| `TZ=UTC` | `2026-08-05T00:00:00Z` | 2026年8月5日 ✅ |
| `TZ=Asia/Shanghai` | `2026-08-04T16:00:00Z` | 2026年8月5日 ✅ |
| `TZ=Pacific/Kiritimati` | `2026-08-04T10:00:00Z` | **2026年8月4日** ❌ |

生产 `deploy/blog.service:24` 设了 `TZ=UTC`，目前侥幸正确；但这是隐式依赖，不是设计。

### 5.5 为什么现有测试没抓到

`tests/time.test.ts` 只测了 10 月：

```ts
assert.equal(monthKeyIn(naive, "Asia/Shanghai"), "2026-10");
```

**恰好是两位月份**。没有任何测试断言归档 label，也没有 1–9 月的用例。

### 5.6 推荐修法（按代价排序）

**方案 A（推荐，根治）**

1. `dateKeyIn` 输出补零 ISO 键（`padStart(2, "0")`），`monthKeyIn/yearKeyIn` 自然变成 `YYYY-MM` / `YYYY`。
2. `listArchives` 过滤空 key，label 用 `Number(ym.slice(5, 7))`（此时安全）。
3. **必须配套数据迁移**：`hits.day` 已按旧格式写入（`lib/visitor-stats.ts:230` 写入、`:293`/`:344` 用字符串 `>=` 比较）。补零后旧行 `2026-8-5` 与 `2026-08-01` 的字符串比较会错位（已验证 `'2026-8-5' >= '2026-10-31'` 为 **true**），「今天/7 天/30 天」统计会算进未来日期。
4. 补 `tests/time.test.ts` 的 1/8/9/10 月用例 + 一条归档 label 断言。

**方案 B（最小改动）**

- 只改 `lib/posts.ts`：label 用 `ym.split("-")[1]`，排序用补零后的 key 或直接按 `ts` 排。
- 不动 `dateKeyIn`，不碰 `hits.day`。
- 代价：`/search`、后台内容列表仍显示 `2026-8-5` 这种不补零日期。

**禁止**：在渲染层 `replace("NaN", "")` —— 掩盖分组键错误，需求文档也明确禁止。

---

## 6. 友链页独立布局与全局布局的耦合

**有耦合，且是「借用 + 覆盖」式的隐性耦合。**

### 6.1 共用骨架类，但在自己的 CSS 里改写了网格

`app/friend-links/page.tsx:128` 使用 `className="site-shell fr-shell"`，`friends.css:31-39` 覆盖：

```css
.site-shell.fr-shell {
  grid-template-columns: var(--w-side) minmax(0, 960px);
  max-width: calc(var(--w-side) + 960px + var(--gap-col) + 64px);
  align-items: start;
}
```

与 `globals.css:183` 的全局公式 `calc(--w-side + --w-main + --w-toc + --gap-col*2 + 64px)` **不同** → 居中基准不同 → 左侧栏横向错位。

**实测**：

| 视口 | 首页 `.sidebar.left` | 友链页 `.sidebar.left` | 偏差 |
| --- | --- | --- | --- |
| 1440 | 32px | 76px | **+44px** |
| 1200 | 24px | 0px | −24px |
| 1100 | 32px | 32px | 0 |
| 900 | 32px | 32px | 0 |

这正是 brief 里写的「友链页面的左侧边栏相比其他页面靠右」。

### 6.2 没有右栏，但布局仍假设右栏存在

`friends.css:773-780` 在 `≤1200px` 又写了一遍相同的 `max-width`（因为全局断点会改 `.site-shell`）。也就是说：**全局布局每改一次，友链页要同步改 3 处**（base + 1200 + 820）。

### 6.3 双页脚叠加

- `app/friend-links/page.tsx:332-335` 有 `<footer className="fr-footer">`（注释写「不重复全站备案信息」）。
- `app/layout.tsx:84` 的 `<FrontOnly><SiteFooter /></FrontOnly>` 也在渲染。

实测（设置 `icp` + `footerText` 后）：

```
/friend-links   fr-footer: 1   site-footer: 1   icp: true
/               fr-footer: 0   site-footer: 1   icp: true
/archives       fr-footer: 0   site-footer: 1   icp: true
```

→ 友链页底部确实有两个 footer 区块。

### 6.4 测试把独立布局写死

`tests/friend-links-page.mjs:125`：

```js
assert.doesNotMatch(body, /class="toc-col"/, "本页不需要右栏目录");
```

将来若统一加右栏，这条测试必须同步改。

### 6.5 移动端 padding 也被改写

`friends.css:783-787` 用 `8px 20px`，全局 `globals.css:783` 用 `14px 20px` → 首屏顶部高度与其他页不一致。

### 6.6 结论与建议

友链页不是「独立布局」，而是「复制了全局布局再覆盖 3 个属性」。改版建议二选一：

- **方案 1**：给 `.site-shell` 增加 `data-layout="three-col | wide"`，由 CSS 变量控制列宽，友链页只声明变体，不再重算 `max-width`。
- **方案 2**：把 shell 宽度抽成 `--w-shell`，各断点只改这个变量，友链页只改 `--w-shell` 与列数。

两种都能把「友链页 3 处 max-width」压到 0 处。

---

## 7. 明暗主题实现

| 环节 | 文件 | 做法 |
| --- | --- | --- |
| 令牌 | `globals.css:4-63` 亮色 `:root`；`:68-102` `[data-theme="dark"]`；`:104-139` `@media (prefers-color-scheme: dark)` 内的 `:root:not([data-theme])` | 同一套 47 个变量**写两遍** |
| 防闪烁 | `components/ThemeScript.tsx` | `<body>` 首个同步内联 `<script>`：读 `localStorage["blog-theme"]`，无值看 `matchMedia`，写 `data-theme` + 改 `meta[name=theme-color]` |
| 交互 | `components/ThemeToggle.tsx` | 本地 state；`apply()` 写 `data-theme` 与 theme-color；监听系统变化（未手动选择时跟随） |
| 优先级 | CSS 选择器 | `html[data-theme]` > 系统 `prefers-color-scheme`，两者用 `:not([data-theme])` 互斥 |
| 评论区 | `CommentSection.tsx:132-151` | `MutationObserver` 监听 `data-theme` → `inst.setDarkMode(currentIsDark())` |
| 字重补偿 | `globals.css:1831-1865` | 暗色下显式字重 −40，**同一份规则写了两遍**（attr + media） |
| 其它硬编码 | `app/layout.tsx:55`、`app/manifest.ts:12-13`、`ThemeToggle.tsx:31`、`ThemeScript.tsx:21` | 亮/暗底色值 `#fffefc` / `#141414` 重复 4 处 |

### 7.1 问题

**（1）全项目没有 `color-scheme`**

```
grep -c "color-scheme" app/globals.css app/admin/admin.css app/friend-links/friends.css
# 全部 0
```

后果：暗色下原生滚动条、`<input type="date">`、`<select>`、自动填充、`<dialog>` 默认背景仍是亮色。这是「暗色模式不彻底」最常见的表现，也直接关系到滚动条观感。

**（2）暗色令牌块两份完全相同**

已逐 token diff 确认：`68-102` 与 `104-139` 的 47 个 token 无任何差异。改一处必忘另一处。

**（3）字重补偿同样两份**

`1831-1846` 与 `1849-1864`，共 21 条规则。

**（4）`ThemeToggle` 多实例状态不同步**

页面上同时挂载 2 个实例（桌面侧栏 + 移动顶栏），后台还有 2 个（`AdminShell.tsx:204`、`:216`）。各自持有 `theme` state，互不通信。

实测：

```
初始: count 2, labels ["切换到夜间模式", "切换到夜间模式"]
点击可见那个后: data-theme=dark, labels ["切换到夜间模式", "切换到白天模式"]
```

→ 隐藏实例的 `aria-label` 仍是过期文案，读屏用户会听到错误提示。

**（5）`settings.timezone` 是死配置**

`lib/time.ts:12` 只读 `process.env.DISPLAY_TZ`；`lib/settings.ts:18,46` 与 `app/api/admin/settings/route.ts:32` 与 `SettingsForm.tsx:57` 存了 `timezone` 却无人使用。

---

## 8. 可以提取为全局变量的样式

### 8.1 已有且应保留

```
--bg / --bg-subtle / --bg-warm / --card-bg / --bg-tint
--text-p0 ~ --text-p4
--border / --border-strong
--link / --link-hover / --accent / --accent-soft
--cat-1~7（每个带 -bg）
--danger / --ok / --warn / --info（各带 -bg / -border）
--font-sans / --font-serif / --font-mono
--w-side / --w-main / --w-toc / --gap-col / --radius / --fs
--tap / --tap-lg / --safe-top / --safe-bottom
--ease / --spring-snap / --spring-pop / --fw-body
```

### 8.2 当前缺失、建议补的（按收益排序）

| 类别 | 建议变量 | 现状证据 |
| --- | --- | --- |
| **容器宽度** | `--w-shell`（把 `max-width` 公式收成一个变量） | shell 宽度计算重复 5 处（`globals.css:183` 与 `1609` 完全相同，`768` 是两栏版；`friends.css:33`、`776` 是友链变体） |
| **滚动区高度** | `--h-sticky-col: calc(100dvh - 96px)` | `globals.css:551` 直接写 `100vh`，全站仅此一处 |
| **圆角** | `--radius-sm/md/lg/xl/pill` | 字面量：`10px`×14、`8px`×6、`12px`×3、`14px`×2、`16px`×2、`11px`×2、`999px`×5；`var(--radius)` **只被用了 1 次** |
| **字号** | `--fs-2xs … --fs-2xl` | `.78rem`×8、`.82rem`×8、`.8rem`×7、`.9rem`×5、`.92rem`×5 |
| **间距** | `--sp-1 … --sp-10` | `gap: 8px`×9、`2px`×5、`6px`×5、`12px`×5、`10px`×5、`14px`×4 |
| **层级** | `--z-topbar: 50` / `--z-drawer: 100` / `--z-dialog: 200` | 现有裸值 `1 / 50 / 100 / 100 / 200 / 200` |
| **动效时长** | `--dur-fast: .15s` / `--dur-base: .2s` / `--dur-slow: .3s` | 31 处 `transition`，时长有 `.15/.16/.18/.2/.24/.25/.3/.5` 八档 |
| **主题色** | `--theme-color`（JS 读 `getComputedStyle` 而非硬编码） | `ThemeToggle.tsx:31`、`ThemeScript.tsx:21`、`app/layout.tsx:55`、`app/manifest.ts:12-13` |
| **触控** | 已有 `--tap / --tap-lg`，但 `44px`/`48px` 仍出现 14/6 次 | 建议全量替换 |

### 8.3 反例：58 个 token 已定义但零引用

`globals.css:1883-1979` 追加了一整段「阶段 01-A 设计令牌」：

```
--space-0 … --space-10
--radius-xs / -sm / -md / -lg / -xl / -2xl / -pill
--fs-2xs … --fs-2xl
--lh-tight / -normal / -loose
--fw-normal / -medium / -semibold / -bold
--btn-* / --field-* / --table-* / --skeleton-* / --toast-*
```

全项目 `var(--<token>)` 引用数为 **0**（脚本逐 token 核验，58 个全部为零）。

这是一套「看起来已经抽象、实际零生效」的死代码。改版时应**先决定是启用还是删除**，不要在上面继续加。

### 8.4 颜色硬编码

`globals.css` 内 **59 个 hex + 97 个 rgba 字面量**。重复最多的是：

- `#5fbfa8` ×4
- `rgba(95,191,168,.13)` ×2
- `rgba(47,122,107,.10)` ×2

都是 `--link` / `--bg-tint` / `--cat-*-bg` 的等价物，散落在暗色令牌与分类色里 —— 改主色要改两处。

---

## 9. 可以复用的组件

### 9.1 已有、应直接复用或轻微泛化

| 组件 | 现状 | 建议 |
| --- | --- | --- |
| `PostCard` | 首页 / 标签 / 搜索 3 处已复用 | ✅ 保留。但 `views` 只有首页传，标签与搜索没有浏览量；建议统一 |
| `Sidebar` | 6 个页面复用 | ⚠️ 改 `usePathname()` 自判 active，去掉 `active` prop |
| `RightBar` | 4 个页面复用 | ✅ 但需把内容区块拆成独立组件 |
| `Animations` | 页面级 `useEffect`，6 处各挂一次 | ⚠️ 建议上移到 `layout`，否则每次路由切换都重新绑定 IntersectionObserver + mousemove |
| `SiteFooter` | 全站 | ✅ 友链页要处理重复 |
| `ThemeToggle` / `ThemeScript` | 全站 | ✅ 需共享状态（Context 或 `useSyncExternalStore` 读 `data-theme`） |
| `CommentSection` | 文章页 + 友链页 | ✅ 保留 |
| `SearchBox` | 首页；搜索页手写了第二份 form（`search/page.tsx:31-45`） | ⚠️ 搜索页应复用 `SearchBox`，现在图标 / placeholder / 尺寸都是另一套 |
| `FriendCard` / `SiteAvatar` / `CopyFriendConfig` / `JumpToComments` | 仅友链页 | ✅ 质量较好，保留 |
| `components/ui/*` | **只有后台在用**（10 个文件引用），前台 0 引用 | 前台若要用 Button/Tabs/Toast，需先确认 `.ui-*` 样式全在 `admin.css`（`.fx-scope .ui-table` 等），前台引入会没有样式 |

### 9.2 明显该抽但没抽的

1. **`PageHeader`**：`<h1 className="page-title">` 在 6 个页面各写一次，副标题/计数又各写 inline style（`archives:38`、`tags:30`、`search:49`）。
2. **`EmptyState`**：`.empty-block` 结构在首页（31-41）、归档（26-32）、说说（22-30）、搜索（58-66、83-86）**重复 5 次**，只有文案不同。
3. **`SidebarBlock`**：`<section class="rb-block"><header class="rb-head">…` 在 `RightBar.tsx` 3 次、`MobileSidebar.tsx` 4 次、`FriendLinks.tsx` 2 次 —— **共 9 处相同结构**。
4. **`LinkRow` / `HubCard`**：`FriendLinks.tsx:14-50` 定义一份，`MobileSidebar.tsx:43-85` **原样抄了第二份**（连 `🚇`/`🔗` emoji 与 `fl-out` ↗ 都一样）。友链页的 `fr-card` / `fr-hub` 是第三套（设计不同，可接受）。
5. **`StatGrid`**：`RightBar.tsx:31-44` 与 `MobileSidebar.tsx:28-41` 完全重复。
6. **`TagCloud`**：`RightBar.tsx:50-71` 与 `MobileSidebar.tsx:87-108` 完全重复。
7. **`SiteShell`**：若不想引入组件，至少抽一个 CSS 变体类，避免 6 处复制 `<div className="site-shell">`。

---

## 10. 重复代码与不合理的 CSS 结构

### 10.1 `globals.css` 已经变成「追加式日志」

1990 行里同一选择器被定义多次（脚本按选择器分组统计，含 keyframes 的 `from`/`to` 在内共 **31 组重复**）：

| 选择器 | 位置 | 现象 |
| --- | --- | --- |
| `.article-title` | 310、1141、792（媒体查询）、1844、1862 | 定义两遍，后者（1141，`2.05rem`）覆盖前者（310，`2rem`）；**移动端 1.5rem 那行（792）因源码顺序被 1141 覆盖** → 实测 375px 下标题仍是 32.8px，移动端标题没有变小 |
| `.article-header` | 309、1136 | 后者多 `padding-bottom` + `border-bottom` |
| `.nav` | 198、1047 | 两套完全不同的写法 |
| `.prose a:hover` | 428、432 | 第二条是第一条的子集，纯冗余 |
| `.mobile-topbar` | 175、802 | 基础 `display:none` + sticky 定义被拆到 600 行之后 |
| `.toc-col` | 547、770、789 | `display:none` 与 `display:none !important` 并存 |
| `:root` | 4、857、1900 | 三处定义令牌（第三处即 58 个死 token） |

### 10.2 `.nav a` vs `.nav-item` 特异性冲突（真实生效错误）

见 2.5。结论：**新导航样式从未生效**，实测 padding `6px 10px`、radius `8px`、font `14.8px`、行高 43px。

### 10.3 reduced-motion 全局块被注释吞掉（a11y 硬伤）

```css
/* globals.css:1815 */
/* ══════════════════════════════════════
@media (prefers-reduced-motion: reduce) {     ← 在注释里面
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
  }
  .slide-up { opacity: 1; transform: none; }
}                                              ← 仍在注释里
/* ── 铁律 3：暗色字重补偿 ── ... */            ← 注释在这里才闭合（1829）
```

第 1815 行只有 `/*` 没有 `*/`，把整段 `@media` 变成了注释。

**构建产物验证**：

```
globals 对应 CSS chunk: animation-duration:.01ms 出现 0 次
admin  对应 CSS chunk: animation-duration:.01ms 出现 1 次
```

**运行时验证**（`reducedMotion: "reduce"` 的浏览器上下文）：

```
themeToggle transitionDuration = 0.16s   ← 应被压到 0.01ms
btn transitionDuration         = 0.15s
```

后果：全站 hover / 进场动画不尊重系统「减少动态效果」；而友链页（`friends.css:846-861`）与后台（`admin.css` 3 处）各自实现了 reduced-motion → **同一需求三套实现，其中全站那套失效**。

### 10.4 `friends.css` 的耦合式覆盖

见第 6 节。另外：`.fr-spec-avatar` 用 `!important` 压 `font-size / color`（575-576），说明上层 `.fr-spec-row dd` 选择器已失控。

### 10.5 内联样式 48 处（前台 20、后台 28）

典型：

- `app/archives/page.tsx:38-44`：年份计数、月份标题、日期全用 inline style
- `app/search/page.tsx:49`
- `app/tags/[tag]/page.tsx:30`
- `app/not-found.tsx:5-7`
- `app/page.tsx:60`：分页「当前页」用 `pointerEvents: "none"` 伪装成按钮

这些都应落成 class，否则暗色 / 响应式无法统一调整。

### 10.6 其它结构问题

- `.site-shell` 的 `max-width` 计算散落 **5 处**（`globals.css:183/768/1609`、`friends.css:33/776`），改宽度必须五处同步。
- `z-index` 无刻度：`1 / 50 / 100 / 200`，抽屉与对话框同层，叠加时靠 DOM 顺序。
- `body { overflow-x: hidden }` 掩盖横向溢出，而不是修溢出来源。
- `100vh`（`.toc-col`）与 `100dvh`（抽屉）混用。
- `.sidebar` sticky `top:40px`、`.toc-col` `top:48px` 基线不齐。
- **死 CSS 类**（把 `className="..."`、模板字面量、以及 `"a b c"` 形式的动态拼接都算进来后，与 TSX 比对）：`.sidebar-footer`、`.toc-title`、`.only-mobile`、`.mobile-drawer-search`、`.empty`、`.comment`、`.comment-avatar/-body/-head/-date/-text`（6 个，评论已改 Artalk，仅剩 `.comment-author` 在后台用）、`.icon-inline`、`.wp-block-embed*`、`.video-container`（WP 兼容，可保留）。脚本粗扫会得到 18–31 个，差异来自 `is-active`/`active`/`in`/`lv3` 这类由 JS 或三元表达式拼接的类名，不能一律判死。
- **死组件**：`components/Avatar.tsx`（0 引用，且引用了**未定义**的 `.brand-avatar` 类）。
- **未使用 import**：`app/layout.tsx:13 ThemeToggle`、`app/tags/[tag]/page.tsx:5 getDb`、`lib/posts.ts:2 dateKeyIn`、`components/friends/CopyFriendConfig.tsx:3 SiteAvatar`。

### 10.7 后台复用前台原子类，靠 `.fx-scope` 逐条覆盖

| 原子类 | 后台覆盖条数 | 后台使用文件数 |
| --- | --- | --- |
| `.btn` | 6 | 19 |
| `.input` | 6 | 15 |
| `.notice` | 5 | 13 |
| `.field` | 4 | 8 |
| `.badge` | 7 | 5 |
| `.dialog-mask/-panel/-actions` | 10 | 4 |
| `.empty-block` | 4 | 1 |

这是前台改版的**最大隐性风险**。

---

## 11. 问题清单

| # | 级别 | 问题 | 文件 · 位置 | 推荐修改 | 风险 |
| --- | --- | --- | --- | --- | --- |
| 1 | **P0** | 归档 1–9 月显示 `NaN 月` | `lib/posts.ts:171` + `lib/time.ts:54,74-80` | `dateKeyIn` 补零，或 label 用 `ym.split("-")[1]`；同步修排序 | 改 `dateKeyIn` 会影响 `hits.day` 历史数据，需 migration（见 #3） |
| 2 | **P0** | 归档月份排序错（10 月排最后） | `lib/posts.ts:170-171` | 用规范化后的 `YYYY-MM` 排序 | 低 |
| 3 | **P0** | 空/非法日期产生空年份分组、`0 月` | `lib/posts.ts:155-164` | 分组前 `if (!y \|\| !ym) continue`（或记 warn 跳过） | 低；会改变「脏数据是否可见」，需确认 |
| 4 | **P0** | 右栏独立滚动，与页面抢滚轮 | `globals.css:547-553` | 去掉 `.toc-col` 的 `max-height/overflow`；只给目录在超长时 sticky + overflow | 右栏很长时会被页面滚走（期望行为）；目录吸顶需重新验证 |
| 5 | **P0** | reduced-motion 全局块被注释吞掉 | `globals.css:1815`（缺 `*/`） | 补 `*/`，把 `@media` 提到注释外 | 低；恢复后动画观感变化，需回归 |
| 6 | P1 | 导航选中态靠手写 `active`，`/about`、`/tags`、`/search` 无选中 | `Sidebar.tsx:14,30`；`ArticleView.tsx:71` | `usePathname()` 自判 + `startsWith` 规则 | 低；`/p/*` 需映射到「文章」 |
| 7 | P1 | 导航数组两份且不一致（文章/首页、友链/朋友、图标与顺序不同） | `Sidebar.tsx:5-11` vs `MobileNav.tsx:9-15` | 抽 `lib/nav.ts` 单一来源 | 低 |
| 8 | P1 | `.nav a` 覆盖 `.nav-item`，新导航样式未生效 | `globals.css:204-212` vs `1048-1087` | 删除旧 `.nav a*` 三条规则，统一到 `.nav-item` | 中：暗色字重补偿引用了 `.nav a.active`（1838/1856），需同步改 |
| 9 | P1 | 友链页左侧栏横向错位 32→76px | `friends.css:31-39`（+773-780） | 抽 `--w-shell`，友链页只改变体类，不重算公式 | 中：影响 6 页 + 页脚对齐 + 2 条测试 |
| 10 | P1 | 友链页双页脚 | `app/friend-links/page.tsx:332-335` + `app/layout.tsx:84` | 删 `.fr-footer`，或给 `SiteFooter` 加 `variant` | 低 |
| 11 | P1 | `/search` 声明三列但无第三列子元素，右侧空 320px | `search/page.tsx:27-89` + `globals.css:181` | 加 `toc-col`，或改 `data-layout="two-col"` | 低 |
| 12 | P1 | 移动端 `/search` 搜索框被 `display:none`，页面无输入框 | `globals.css:1294-1296` 命中 `search/page.tsx:31` | 换类名（如 `.page-search`）或加例外 | 低，但直接影响可用性 |
| 13 | P1 | 右栏内容两套实现（桌面/移动各写一遍） | `RightBar.tsx` vs `MobileSidebar.tsx` | 抽 `StatsBlock/LinksBlock/TagCloudBlock`，两端复用 | 低；两者取数都在服务端 |
| 14 | P1 | `SidebarSheetProvider` 的 `panel` 在 `/admin` 也被服务端渲染（多查 3 次库、多传 HTML） | `app/layout.tsx:80` `panel={<MobileSidebarContent/>}` | 把 Provider 移进 `FrontOnly`，或 panel 改为按需 | 低；实测 `/admin` HTML 含 `.rb-block`/`stat-grid`/友链名 |
| 15 | P1 | 暗色令牌块 / 字重补偿各重复两份 | `globals.css:68-102` vs `104-139`；`1831-1865` | 合并为一份，用 `:where()` 统一选择器 | 低；需确保系统暗色与手动暗色都命中 |
| 16 | P1 | 缺 `color-scheme`，暗色下原生控件/滚动条仍是亮色 | `globals.css` 全文件 | `:root{color-scheme:light}`、`[data-theme=dark]{color-scheme:dark}`、media 内同步 | 低，但会改变表单控件默认外观 |
| 17 | P2 | 58 个 token 零使用 | `globals.css:1883-1979` | 决定启用（并全量替换）或删除 | 低；`tests/design-tokens.test.ts` 只校验「引用必须有定义」 |
| 18 | P2 | `.article-title` 移动端 1.5rem 被后面 2.05rem 覆盖 | `globals.css:792` vs `1141` | 合并为单一定义 + 媒体查询 | 低；实测 375px 当前 32.8px |
| 19 | P2 | 圆角/字号/间距/动效时长全为字面量 | `globals.css` 全文 | 按第 8 节补 token | 低，但改动面大，建议分页推进 |
| 20 | P2 | 内联样式 48 处（前台 20、后台 28） | `archives:38-44`、`search:49`、`tags:30`、`not-found:5-7`、`page:60` | 落成 class | 低 |
| 21 | P2 | 站点名/简介/主题色硬编码，与 settings 不一致 | `Sidebar.tsx:20-22`、`MobileNav.tsx:91`、`app/manifest.ts:5-7`、`app/layout.tsx:55`、`ThemeToggle.tsx:31`、`ThemeScript.tsx:21` | 品牌区从 `getSettings()` 取；theme-color 由 JS 读 CSS 变量 | 低；`manifest.ts` 是静态路由，取值需评估 |
| 22 | P2 | `settings.timezone` 是死配置 | `lib/time.ts:12` 只读 env；`settings.ts:18,46` | 让 `formatIn` 默认值读 settings，或从后台移除 | 低；改默认值影响全部日期展示 |
| 23 | P2 | 后台大量复用前台 `.btn/.notice/.input/.badge/.field/.empty-block`，靠 `.fx-scope` 覆盖 | `admin.css:699-740` 等 | **不要改这些类的语义**；或拆 `front.css` / `admin.css` 两份原子 | **高**：动 `.btn` 影响后台 19 个文件 |
| 24 | P2 | 测试对前台类名有硬依赖 | `tests/friend-links-page.mjs:125,132,135`；`tests/dark-mode.mjs` 用 `.btn-danger` | 改类名/结构时同步改测试 | 中 |
| 25 | P2 | 死代码：`Avatar.tsx`、一批未被引用的 CSS 类、4 处未使用 import | 见 10.6 | 删除 | 低 |
| 26 | P2 | sticky 基线不齐（sidebar 40 / toc 48） | `globals.css:191,549` | 统一 `--sticky-top` | 低 |

---

## 12. 推荐修改方案

### 阶段 A：先修「确定性 bug」，不动视觉

1. `lib/time.ts` 增加补零 ISO 键（或修正 `dateKeyIn`）+ `tests/time.test.ts` 补 1/8/9/10 月断言。
2. `lib/posts.ts:155-171` 过滤空分组、用规范化 key 排序、label 从 key 取。
3. `globals.css:1815` 补 `*/`，恢复全局 reduced-motion。
4. 若采用方案 A，写数据 migration 归一化 `hits.day`，并补 `'2026-8-5' >= '2026-10-31'` 的回归测试。
5. 跑 `npm run test:integration` + `tests/friend-links-page.mjs` 确认零回归。

> 本阶段**不碰类名、不碰布局**，风险最低，能立刻消掉截图里的 NaN 与「动画不尊重系统设置」。

### 阶段 B：布局骨架收敛

1. 抽 `--w-shell` + `.site-shell` 的 `data-layout` 变体（`three-col` / `wide`），友链页只声明变体。
2. 去掉 `.toc-col` 的 `max-height/overflow`，目录单独 sticky。
3. `Sidebar` 改 `usePathname()`；导航数组抽 `lib/nav.ts`；删除旧 `.nav a*`。
4. `SiteFooter` 与友链页 `.fr-footer` 二选一。
5. `/search` 补第三列或声明 two-col；移动端搜索框恢复。

### 阶段 C：令牌与组件

1. 决定 `1883-1979` 那 58 个 token 的去留（建议**先删，再按实际替换逐个加回**）。
2. 按第 8 节补 `--w-shell / --radius-* / --fs-* / --sp-* / --z-* / --dur-*`，**只在新代码和本次改动的页面里用**；不要一次性全量替换（1990 行 CSS 全量替换回归面太大）。
3. 抽 `PageHeader`、`EmptyState`、`SidebarBlock`、`StatsBlock/LinksBlock/TagCloudBlock`。
4. `ThemeToggle` 改共享状态（Context 或 `useSyncExternalStore` 读 `data-theme`）。

### 阶段 D：视觉改版

按需求文档顺序：首页 → 关于 → 友链 → 说说。归档已在阶段 A 修完。

---

## 13. 修改风险汇总

| 风险 | 触发点 | 缓解 |
| --- | --- | --- |
| **改 `.btn/.notice/.input/.badge` 影响后台** | 后台 19 个文件用 `.btn`，13 个用 `.notice`，15 个用 `.input`，5 个用 `.badge` | 前台改版**新增**类或新增覆盖层，不动原子类；改完必跑 `test:admin` / `test:dark` / `test:ui` |
| **改 `.site-shell` 影响 6 页 + 页脚 + 友链页** | `globals.css:178/765/773/1608`；`friends.css:31/773/782` | 先抽 `--w-shell` 再改值；用 1440/1201/1200/1100/900/821/820/375 八档对比（本文已建立基线） |
| **改 `dateKeyIn` 影响 hits 统计** | `lib/visitor-stats.ts:230,293,344` | 必须先 migration 归一化 `hits.day`，再改函数；否则「今天/7 天」会算进未来日期 |
| **改导航类名影响暗色字重补偿** | `globals.css:1838,1856` 引用 `.nav a.active` / `.nav-item.is-active` | 同步替换；`tests/dark-mode.mjs` 只盯后台，前台暗色无自动断言，需人工看 |
| **改类名/结构导致集成测试失败** | `friend-links-page.mjs:125`（断言无 `toc-col`）、`:132`（`site-shell`）、`:135`（`page-title` 文案） | 改布局时同步更新测试断言，不要为了过测试保留错误结构 |
| **reduced-motion 恢复后动画观感突变** | 全局 `transition-duration` 被压到 `.01ms` | 只在用户系统开启「减少动态」时生效，属预期；截图对比即可 |
| **`.toc-col` 去 overflow 后长目录** | 文章目录可能超过视口 | 目录单独 `position:sticky; max-height:calc(100dvh - Xpx); overflow:auto`，加 `overscroll-behavior:contain` 避免滚动链 |
| **提取 token 后暗色失效** | `tests/design-tokens.test.ts` 只抓「引用但没定义」，抓不到「定义了却写死 fallback」 | 新 token 必须在 `:root` 与两套暗色块里都定义 |

---

## 14. 附：本次审查的验证方法

### 14.0 审查边界与副作用

- **源码零改动**：未修改、未新建任何 `.tsx` / `.ts` / `.css`；本文档是唯一新增文件。
- **数据库**：所有写入都在 `.tmp-tests/` 下的临时 `DATA_DIR` 里（`startIsolatedServer()` 每次 `mkdtemp`）。开发库 `data/blog.db` 被以只读方式查询过一次表结构，但 better-sqlite3 打开 WAL 库会触发 checkpoint，导致 `blog.db` / `blog.db-wal` 的文件大小与 mtime 变化；**数据行数未变**（`posts=0`、`friend_links=1`、`schema_version` 停在 `0014`）。
- **临时产物**：审查结束后已清理自己留下的 `.tmp-tests/audit-*` 目录；`.tmp-review/`、`.tmp-tests/` 里的历史文件未动。
- 仓库里 `docs/*.md` 的删除与 `docs/writing-block.md` 的新增是审查开始前就存在的工作区状态，与本报告无关。

### 14.1 静态核对

```bash
# 类名使用统计（确认 0 个 Tailwind 工具类）
grep -rEo 'className="[^"]*"' app components --include=*.tsx

# 令牌引用（确认 58 个新 token 零引用）
grep -rn "var(--" app components --include=*.css --include=*.tsx

# 重复选择器（31 个）
# 用 postcss 解析 globals.css，按 selector 分组统计

# 未使用 CSS 类（脚本粗扫 18–31 个，需人工复核动态类名）
# 提取 globals.css 全部 .class，再与 TSX 源码比对

# 类型检查
npx tsc --noEmit          # 通过
```

### 14.2 运行时测量

用 `tests/helpers/next-server.mjs` 的 `startIsolatedServer()` 起隔离 standalone（临时 `DATA_DIR`），再用 Playwright 在真实浏览器里测量：

- 布局：1440/1201/1200/1100/900/821/820/375 八档的 `gridTemplateColumns`、`.content` 宽度、`.sidebar.left`
- 滚动：`<div>` 元素中 `overflow-y: auto|scroll && scrollHeight > clientHeight` 的容器清单；滚轮前后 `scrollY` 与 `tocScrollTop`
- 主题：`prefers-reduced-motion: reduce` 下的 `transitionDuration`
- 归档：向隔离库直接 `INSERT` 不同月份文章后抓 `/archives` 的 HTML 片段

### 14.3 关键实测数据存档

| 项目 | 数值 |
| --- | --- |
| 1440 首页列宽 | `288 / 688 / 320` |
| 1201 首页列宽 | `288 / 449 / 320`（断崖） |
| 1200 首页列宽 | `288 / 760` |
| 18 友链时 `.toc-col` | `clientHeight 704 / scrollHeight 1647` |
| 右栏内滚轮 | `pageY 0→0`，`tocScrollTop 0→600` |
| 导航项计算样式 | `padding 6px 10px`、`radius 8px`、`font 14.8px`、高 43px |
| 375px 文章标题 | `32.8px`（移动端规则未生效） |
| reduced-motion 下主题按钮过渡 | `0.16s`（应为 0.01ms） |
| 构建产物 globals chunk 中 `.01ms` | 0 次 |

---

## 15. 快速结论（给改版执行者）

1. **先修 5 件事**：NaN 月、归档排序、空日期分组、右栏独立滚动、reduced-motion 注释。这 5 件与视觉改版解耦，可独立提交。
2. **布局是 6 处复制粘贴 + 友链页 1 处变体（3 个属性覆盖）**。改版前先收敛 shell，否则每改一个页面都要改 7 遍。
3. **双滚动条根因是一行 CSS**（`.toc-col` 的 `max-height + overflow-y`），不是浏览器问题，也不是 sticky 失效。
4. **友链页是耦合最重的地方**：左栏错位 44px、双页脚、断点维护 3 份、测试写死「无右栏」。
5. **主题系统完整但重复**：三态 + 防闪烁 + Artalk 同步都有；问题是令牌两份、缺 `color-scheme`、多实例不同步。
6. **58 个 token 全部未使用**，改版时不要再往上加，先清理再按需引入。
7. **最大隐性风险在后台**：前台 `.btn/.input/.notice/.badge/.dialog/.empty-block` 与后台共用，任何原子类改动都要跑后台三套测试。
