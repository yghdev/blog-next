# 设计系统约束（B 端 + 移动端）

> 建立于 2026-10-25，2026-10-28 随后台视觉改版重写。
> 这份文件是**可执行的约束**，不是风格建议。改后台或移动端布局前先读一遍；改完跑文末的自查。

站点有两套界面，规范来源不同，不要混用：

| 界面 | 规范 | 关键词 |
| --- | --- | --- |
| 前台（读者看） | 移动端工业级规范 | 安全区、44/48dp 热区、底部抽屉、软键盘 |
| 后台 /admin | Flechazo 后台设计系统（本文第二节） | 编辑部排版、留白优先、表面稀少、双状态 |

---

## 一、令牌分两套，不要混用

| 作用域 | 令牌前缀 | 定义位置 | 谁在用 |
| --- | --- | --- | --- |
| 前台 | `--bg` / `--text-p0~p4` / `--link` / `--border` | `app/globals.css` 顶部 `:root` | 前台页面 |
| 后台 | `--fx-*` | `app/admin/admin.css` 顶部 `:root` | 后台页面 + 后台浮层 |

**为什么后台要独立一套**：后台的视觉语言（暖纸底、赤陶点、衬线大标题）与前台
（纯白极简）目标不同。共用一套令牌，任何一次调整都会在两处产生非预期的副作用。
`admin.css` 只被 `app/admin/layout.tsx` 引入，前台永不加载，所以它能安全地定义
后台专属的表面、密度与排版。

**历史坑**：改版前 `admin.css` 只是对前台令牌的映射（`--admin-canvas: var(--bg-subtle)`），
于是后台看起来就是「前台换了个排列」。现在后台令牌是独立值。

### 后台令牌速查

| 用途 | 令牌 | 浅色 | 深色 |
| --- | --- | --- | --- |
| 页面底 | `--fx-canvas` | `#f5f2eb` 暖纸 | `#15140f` 近墨棕黑 |
| 内容表面 | `--fx-surface` | `#fbfaf6` | `#1c1b16` |
| 浮层表面 | `--fx-raised` | `#fffdf9` | `#22201a` |
| 凹槽 | `--fx-sunken` | `#efece3` | `#100f0b` |
| 主文字 | `--fx-ink` | `#20231f` 14.2:1 | `#edeae2` 15.3:1 |
| 次级正文 | `--fx-ink-2` | `#45483f` 8.3:1 | `#d9d5ca` 12.6:1 |
| 辅助文字 | `--fx-muted` | `#63625a` 5.5:1 | `#a8a396` 6.9:1 |
| 最弱文字 | `--fx-faint` | `#6e6d65` 4.9:1 | `#8b8779` 4.8:1 |
| 分隔线 | `--fx-line` | `#e7e1d7` | `#2c2921` |
| 主强调 | `--fx-brand` | `#36796b` 4.6:1 | `#6fb3a1` 7.1:1 |
| 主按钮填充 | `--fx-brand-fill` / `--fx-brand-on` | `#36796b` / `#fff` | `#4e9e8b` / `#101210` |
| 次强调 | `--fx-accent` | `#d77858`（**只做标记，2.8:1 不当文字**） | `#d99372` 6.9:1 |
| 次强调当文字 | `--fx-accent-text` | `#a94f31` 4.9:1 | `#d99372` |

语义状态：`--fx-ok` / `--fx-warn` / `--fx-danger` / `--fx-info`，各带 `-bg` 与 `-line`。
**状态色按语义分配，不复用品牌色冒充状态**。

规范给定的 `#77776F` 作为辅助文字在纸底只有 4.04:1（不达 AA 4.5:1），
已校准为 `#6E6D65`（4.9:1）。这是「允许小幅校准」的实例，色相不变。

### 深色主题

深色**不是浅色的反转**：底色带暖（近墨的棕黑而非纯灰），强调色整体提亮，
状态色提高亮度并压低底色比例以防「黑底黑字」。三处定义必须同步：
`:root[data-theme="dark"]`、`@media (prefers-color-scheme: dark)` 内的
`:root:not([data-theme])`，以及前台的暗色字重补偿。

---

## 二、后台设计系统的六条硬约束

### 1. 不是卡片堆叠

**只有「独立操作区 / 需要明确边界的模块」才配拥有表面。**

- 列表 → 留白 + 1px 细线（`.data-row`），**不用**卡片
- 统计 → 一行数字 + 上下细线（`.fx-figure-row`），**不用**彩色卡片
- 设置分组 → 衬线组标题 + 细线 + 组间大留白（`.settings-group`），**不用**卡片
- 真正需要边界的：`.card` / `.fx-panel`（如存储配置这类「独立保存单元」）

判据是一句话：**把这块内容的背景去掉，还能不能看出它是一组？** 能，就不要背景。

### 2. 层次靠排版，不靠装饰

| 层级 | 字体 | 字号 | 用在哪 |
| --- | --- | --- | --- |
| 页面标题 | `--font-serif` | `clamp(1.75–2.25rem)` 负字距 | `.page-head h1` |
| 卡片/弹窗标题 | `--font-serif` | `--fx-fs-lg` | `.fx-panel-title`、`.dialog-title` |
| 正文 | 无衬线 | `--fx-fs-base` (15px) | 列表标题、表单值 |
| 辅助 | 无衬线 | `--fx-fs-sm` (13px) | 说明、筛选 |
| 元信息 | 无衬线 + `tabular-nums` | `--fx-fs-xs` (12px) | 日期、计数 |
| 眉标 | 无衬线 + 0.12em 字距 | `--fx-fs-micro` (11px) | 分组标题、`.page-head-eyebrow` |

中文回退链来自 `--font-sans`（PingFang / 雅黑 / 思源），**不引入任何网络字体**，
避免首屏闪换与中文回退异常。

### 3. 状态标记分两档

- **`.fx-state`（首选）**：圆点 + 文案，不铺底。列表行里的「已发布 / 草稿」用它。
  已发布是实心点（确定的），草稿是空心点（还没落地）。
- **`.badge`**：浅底深字胶囊。只给「需要与正文混排并跳出视线」的少量信息
  （计数、类型、标签）。

**一屏 20 行都挂胶囊会变成一条彩虹**，反而扫不出任何东西。

### 4. 主操作唯一

- 「写文章」常驻侧栏（桌面）/ 抽屉顶部（手机），**页面里不再重复出现**
- 一个操作区最多一个 `.btn-primary`
- 危险操作 `.btn-danger` 是浅底深字，**绝不主色铺红**（那是视觉诱导）
- 不可逆操作必须过 `ConfirmDialog`：标题中立交代对象，描述写清连带后果，
  按钮是动宾文案（「彻底删除」「移入回收站」）。`window.confirm` 一律不用

### 5. 阴影只属于浮层

`--fx-shadow-1/2/3` 只用于弹窗、下拉、命令面板、批量条（它确实浮在内容上）。
列表、卡片、统计一律**没有**阴影。`--fx-shadow-*` 在暗色下是纯黑投影，
不是把浅色阴影调深。

### 6. 作用域：`.fx-scope`

后台所有视觉规则都写在 `.fx-scope` 下。它挂在：

- `.admin-shell`（所有后台页面）
- 登录页容器
- `ConfirmDialog` / `BottomSheet` / `Toast` / `CommandPalette` 的 portal 容器

**portal 出去的浮层逻辑上属于后台，物理上不在 `.admin-shell` 里**，
所以它们必须自己带 `.fx-scope`，否则浮层里的按钮会退回前台样式。
令牌本身挂在 `:root`（带 `--fx-` 前缀）就是为了让 portal 也能取到。

---

## 三、B 端硬门禁（后台）

1. **列表骨架固定四段**：`PageHeader`（眉标 + 衬线标题 + 数量）→ 筛选条 →
   数据区 → 分页。页面里不写行内 padding / 魔法数字，全走 `--fx-*` 与 `.fx-*` 类。
2. **空状态要有出口**：`Empty` 的 title/hint/actions —— 说清为什么为空 + 给一个动作。
   列表内的小空态用 `EmptyLine`，不要占一整块留白。
3. **数值列右对齐 + 等宽数字**（`.data-row-meta`、`.fx-figure-value`）。
4. **边框用 1px 半透明当 0.5px 用**：`--fx-line` / `--fx-line-strong`。
5. **行内操作默认隐藏**，悬停或 `:focus-within` 时出现；`(hover: none)` 与
   `≤820px` 一律常显 —— **手机上不能依赖 hover 才能操作**。
6. **键盘焦点必须可见**：`.fx-scope :focus-visible` 统一 2px 品牌色轮廓。
   用 `:focus-visible` 而不是 `:focus` —— 点鼠标也画框会让界面很吵。

---

## 四、移动端硬门禁（前台 + 后台的手机态）

1. **安全区**：所有 fixed / sticky 的贴边容器必须避让 ——
   底边 `calc(Npx + var(--safe-bottom))`，顶边 `calc(Npx + var(--safe-top))`。
2. **触控热区 ≥44pt（iOS）/ 48dp（Android）**：小图标靠容器或 padding 扩，
   不改视觉尺寸。后台已达标：顶栏三控件、列表标题整行、分页、按钮、工具栏。
   **注意**：`.ui-tab` 只有「文章」两字时纯文字宽 28px，必须给 `min-width`。
3. **滚动穿透**：浮层一律用 `useScrollLock`（`components/ui/useScrollLock.ts`）。
   **不要**只写 `body.style.overflow = "hidden"` —— iOS Safari 直接忽略。
4. **软键盘**：输入框聚焦由 `MobileKeyboardGuard` 滚到视口中部；
   手机端输入框字号钉 16px，否则 iOS 会强制放大整页。
5. **浮层高度用 `dvh` 不用 `vh`**：iOS 地址栏收放时 `vh` 不跟着变。
6. **浮层挂 Portal 到 body**：顶栏有 `backdrop-filter`，会给 `position: fixed`
   创建新包含块，抽屉会被困在 54px 的头部里。
7. **不用原生 `<table>` 承载手机列表**：一律 `.data-row` 卡片，≤820px 自动折行。
8. **无横向滚动**：`document.documentElement.scrollWidth === clientWidth`。

---

## 五、浮层选型

| 场景 | 用什么 |
| --- | --- |
| 查看详情、保留列表上下文 | 侧边抽屉 / 同页展开 |
| 确认破坏性操作 | `ConfirmDialog`（桌面居中，手机自动变底部抽屉） |
| 移动端多选项、筛选 | `BottomSheet`（三分屏，≤80dvh） |
| 录入表单的浮层 | `maskClosable={false}`，退出必须点「取消」 |
| 全局跳转与搜索 | `CommandPalette`（Ctrl/Cmd+K，防抖 + 空/错误态 + 不劫持输入框） |
| 从已有资源里挑一个 | `MediaPicker`（编辑器内「媒体库」，只做插入不做管理） |

---

## 六、组件对照页

`/admin/dev/ui` —— **只用真实公共组件**，没有 fixture 专用样式。
生产默认 404（`ADMIN_UI_KIT=1` 可开启），不进导航、`noindex`。

覆盖：Button 五态、Field 含错误、Skeleton、Tabs、StatBar、DataTable、
Toast 四种 tone、State/Badge 分工、列表行、批量条、Figure、空状态、
品牌标识、危险区。

**改组件先在这里看双主题与窄屏，再去动页面。**

---

## 七、交付前自查

```bash
cd blog-next
node node_modules/typescript/bin/tsc --noEmit
npm test                    # 含 design-tokens.test.ts：类名/令牌完整性
npm run build

# 浏览器侧（需要真实 Chromium）
npm run test:ui && npm run test:dark && npm run test:admin
npm run test:content && npm run test:comments && npm run test:media && npm run test:settings
npm run test:autosave && npm run test:editor && npm run test:cmdk
```

`tests/design-tokens.test.ts` 会在两条上卡住改版：
**引用了但没定义的 `--token`**（fallback 会静默接管，暗色主题凭空失效）、
**用了但没样式的 `className`**（写错类名不报错，只是「看起来差点意思」）。
改完样式跑一遍，它会直接告出文件名与缺失项。

### 上传体积：三个数字必须同步

| 位置 | 值 | 作用 |
| --- | --- | --- |
| `lib/upload.ts` `MAX_UPLOAD_BYTES` | 8MB | 图片上限（应用层判定） |
| `lib/upload.ts` `MAX_VIDEO_BYTES` | **16MB** | 视频上限（应用层判定） |
| `next.config.ts` `experimental.proxyClientMaxBodySize` | 20mb | Next 读进内存的上限 |
| `deploy/nginx-blog.conf` `client_max_body_size` | 20m | 网关上限 |
| `lib/image-plan.ts` 的两个 `_ASSUMED` | 同上 | 客户端预检副本 |

**改任何一个都要同步其余几个。** 少改哪一层，就会在那一层被挡，而且报错常常
指不到体积上：

- 只改应用层不改 Next → 超出部分被**静默截断**，接口拿到空 `file` 字段，
  报「没有收到文件」。这是 2026-10-28 上传视频时真实踩到的坑，排查了两轮。
- 只改应用层不改 nginx → nginx 直接 413，应用层连日志都没有。

### 上限由内存决定，不由"想要多大"决定

2026-10-28 线上事故：视频上限最初设 40MB，一次 40MB 上传把整个 Node 进程顶进
cgroup 节流（`wchan=mem_cgroup_handle_over_high`，D 状态，swap 抖动），
**同进程所有请求一起超时，连前台首页都挂了**。

实测上传的内存放大（整个 multipart body 在第 28 行的 route handler 之前就被
Next 读进内存，连被拒的请求也照样花掉这份内存）：

| 文件 | RSS 增量 | 倍率 |
| --- | --- | --- |
| 10MB | +56MB | 5.6× |
| 16MB | +104MB | 6.5× |
| 20MB | +129MB | 6.5× |
| 25MB | +159MB | 6.4× |

本机 `MemoryHigh=300M`、生产基线峰值约 120MB，所以：

- 16MB 上限 → 峰值约 224MB，留 76MB 余量，安全（已实测）
- 40MB 上限 → 约 380MB，**必然触顶**

**要调大上限，先算 `基线 + 6.5 × 上限 < MemoryHigh`。** 更大的视频走平台外链
（B 站/YouTube，编辑器支持）——那本来也更合适：出口带宽 400~700KB/s，
40MB 的片段访客要等 60~100 秒。

代码里另有一道**早期拒绝**：先看 `Content-Length`，超限就直接返回，
不再解析 multipart。它省不掉已经花掉的内存（Next 早已缓冲完），但能让
请求快速失败，不至于在解析上再叠一层开销。

`tests/image-plan.test.ts` 会断言两个 `_ASSUMED` 与服务端常量一致，
另有一层是人工核对（Next / nginx 的配置无法在单测里验证）。

### 视频为什么用 `<video>` 而不是 iframe

自托管视频就在本站域名下，原生 `<video controls playsinline>` 才能拿到进度条、
全屏、画中画，也不必为它放宽 CSP 的 `frame-src`。`playsinline` 不能省 ——
少了它 iOS 会在点播放时强制全屏接管整个页面。
平台外链（B 站/YouTube）仍走 iframe，那是另一条路径（`lib/video-embed.ts`）。

真机量一遍（headless Chrome + CDP）比肉眼可靠：

- `document.documentElement.scrollWidth > clientWidth` → 有横向溢出
- 所有 `a / button` 的 `getBoundingClientRect()` 宽高 → 找出 < 44 的
- 打开浮层后 `getComputedStyle(document.body).position` → 应为 `fixed`
