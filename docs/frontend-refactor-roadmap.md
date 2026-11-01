# 博客前端重构 · 开发实施方案（Roadmap）

> 文档版本：v1.1 · 2026-10-31（修订记录见第 16 节，未消除的风险见第 17 节）
> 输入：`docs/frontend-review.md`（代码审查）、`docs/writing-block.md`（改版需求）
> 基线：`master` @ `07519eb`，`tsc --noEmit` 通过，`npm test` 282/282 通过
> 本文档**只做规划**。除本文件外未修改任何源码、CSS、数据库或测试。

---

## 0. 怎么用这份文档

1. **按任务编号执行**，不要按阶段整体重写。每个任务都是「可独立提交、可独立回滚」的最小单元。
2. 任务字段固定为：涉及文件 / 当前问题 / 计划修改 / 预期效果 / 潜在影响 / 风险等级 / 验收标准。
3. 任务编号规则：`A-3` 表示阶段 A 第 3 个任务。依赖写作 `依赖 A-1`。
4. **每个任务开始前先跑一次** `npm test && npx tsc --noEmit`，确认起点是绿的。起点不绿就不要往下做。
5. 每个阶段结束都必须满足：能 `npm run build`、能 `npm run test:integration`、能独立回滚。
6. 若发现本文档与代码不一致：**以代码为准**，并在第 1.3 节「差异记录」追加一条，不要默默按文档改。

### 0.1 硬性红线（贯穿全程）

| # | 红线 | 为什么 |
| --- | --- | --- |
| 1 | 不改 `.btn / .input / .notice / .badge / .field / .dialog-* / .empty-block` 的**语义** | 后台 19 个文件用 `.btn`、14 个用 `.input`、13 个用 `.notice`、5 个用 `.badge`；`admin.css` 里有 288 处 `.fx-scope …` 覆盖在改写这些类 |
| 2 | 不新增 `!important` 去压冲突 | 现有 `!important` 共 16 处（globals 10 / friends 3 / admin 3），其中 `.toc-col{display:none!important}` 就是历史债 |
| 3 | 不用 `overflow:hidden` / `scroll-behavior` 掩盖溢出 | `body{overflow-x:hidden}` 已在掩盖问题，再加只会扩大盲区 |
| 4 | 不一次性重写 `globals.css`（1990 行） | 回归面 = 7 个前台入口（首页/归档/说说/标签/搜索/文章/友链）+ 后台全部页面 |
| 5 | 不删除、不跳过现有测试 | `npm test` 的 282 个用例（21 个文件）+ `test:integration` 串联的 16 个套件（HTTP 集成 + Playwright）是唯一的安全网 |
| 6 | 不对生产库做未备份写入，**且生产写入必须经用户授权** | `data/blog.db` 由 `blog-backup` 每日 04:00 快照，迁移前必须手动再快照一次；Agent 不得自行连生产库 |
| 7 | 不改文章 URL（`/p/<id>`）、RSS、sitemap、搜索接口 | 已发出去的链接与搜索引擎索引 |
| 8 | 不引入新的运行时依赖 | 项目零图表依赖、零 UI 库，靠手写 CSS 活着 |

### 0.2 执行边界：本地 / 临时库 / 生产（**先读这节再动手**）

三类环境，权限完全不同。**跨类操作一律需要用户显式授权，Agent 不得自行跨越。**

| 类别 | 具体范围 | 谁可以做 | 需要授权？ |
| --- | --- | --- | --- |
| **① 本地源码与本地开发** | 改 `app/` `components/` `lib/` `tests/` `scripts/`（**除 `deploy.sh`**）、跑 `npm test` / `tsc` / `build` / `dev` | Agent 可以 | 否 |
| **② 临时数据库测试** | `DATA_DIR` 指向 `.tmp-tests/**` 的隔离库；`startIsolatedServer()` 起的临时 standalone；在**备份副本**上跑 dry-run | Agent 可以 | 否（但必须确认 `DATA_DIR` 真的在 `.tmp-tests` 下，见下） |
| **③ 真实数据与生产** | `data/blog.db`（开发库，含真实内容）、`/var/lib/blog/blog.db`（生产库）、`blog-backup`、`deploy.sh`、`systemctl restart blog`、nginx 配置 | Agent **不可以**自主执行 | **是，每次都需明确授权** |

**② 类的三条硬约束**

1. `DATA_DIR` 必须落在 `.tmp-tests/` 或系统临时目录下。仓库已有护栏：`tests/helpers/isolated-db.ts` 的 `assertIsolatedDataDir()` 会拒绝 `data/` 与项目外路径，**不要绕过它**。
2. 就算只是"看一眼表结构"，也**不要**用默认 `DATA_DIR` 打开 `data/blog.db`：better-sqlite3 的 `journal_mode=WAL` 会在打开时触发 checkpoint，改变 `blog.db` / `blog.db-wal` 的 mtime 与大小（本次审查已实测到这一点）。只读需求请用 `new Database(path, { readonly: true })`，并且在**副本**上做。
3. 临时目录用完即删，删除前用 `realpath` 确认目标确实在 `.tmp-tests/` 下——不要对拼接出来的路径直接 `rm -rf`。

**③ 类的授权清单（每一项都要单独点头，一次授权只管一次）**

| 操作 | 说明 | 不做会怎样 |
| --- | --- | --- |
| 生产备份 `blog-backup` | 生成 `.backup` 快照并校验 | 没有回退点，迁移不可逆 |
| 生产库迁移（0015） | `migrate()` 在首个请求时应用 | 统计口径继续错 |
| 正式部署 `deploy.sh` | 原子切换 release | 改动上不了线 |
| 数据恢复（用备份覆盖 `blog.db`） | 回滚数据 | 出错时无法恢复 |

**④ Git 纪律**

- **不覆盖用户未提交的修改**。当前工作区已有未提交内容（`docs/*.md` 的删除、`docs/writing-block.md` 与 `docs/frontend-review.md` 的新增），这些**都不是本次任务产生的，不要 `git checkout --` / `git stash` / `git reset --hard` 去动它们**。
- 每个任务一个 commit（`A-1: …`、`B-3: …`），**不要把一个阶段的所有改动压成一个提交**——回滚粒度等于提交粒度。
- 每个阶段结束**停下来等用户验收**，验收通过再开下一阶段。不要连续跨阶段推进。

---

## 1. 项目现状（已按真实代码核对）

### 1.1 技术栈事实

| 项 | 事实 | 证据 |
| --- | --- | --- |
| 框架 | Next.js 16.4.2，App Router，`output: "standalone"` | `next.config.ts:92` |
| React | 19.3.1 | `package.json` |
| 数据 | SQLite + better-sqlite3 12.11.1，DDL 唯一来源 `lib/migrations.ts` | `lib/db.ts:20` 调 `migrate()` |
| 迁移 | 15 个（0001–0014），按 name 排序执行，逐条幂等，只前进不后退 | `lib/migrations.ts:593-616` |
| 样式 | 手写 CSS：`globals.css` 1990 行、`friends.css` 890 行、`admin.css` 5276 行 | `wc -l` |
| Tailwind | 已安装且 `@import "tailwindcss"` 生效，但全项目 1332 个 class token 里只有 `sr-only`/`select-all` 两个"像 Tailwind"的名字，且都在 `admin.css` 里自定义过 → **实际只用到 Preflight** | 扫描结果 |
| class token 分布 | 前台 366 个 / 后台 966 个 | 扫描 `app`+`components` 的 `className=` |
| 渲染 | 前台页面全部 `force-dynamic`，只对数据读取做 `unstable_cache`（TTL 300s，`getViewsMap` 60s） | `lib/cached.ts` |
| 测试 | `tests/*.test.ts` 21 个文件（282 用例）；`tests/*.mjs` 19 个文件，其中 16 个被 `test:integration` 串联 | `ls tests`、`package.json` |

### 1.2 六个前台骨架 + 一个变体

| 页面 | 文件 | 骨架行号 | 右栏 |
| --- | --- | --- | --- |
| 首页 | `app/page.tsx` | 23-68 | 有（`:67`） |
| 归档 | `app/archives/page.tsx` | 21-59 | 有（`:58`） |
| 说说 | `app/shuoshuo/page.tsx` | 16-40 | 有（`:39`） |
| 标签 | `app/tags/[tag]/page.tsx` | 26-47 | 有（`:46`） |
| 搜索 | `app/search/page.tsx` | 27-89 | **声明了三列网格但没有第三个子元素** |
| 文章/关于 | `components/ArticleView.tsx` | 70-148 | 有（`:147`，带 `toc`） |
| 友链 | `app/friend-links/page.tsx` | 128-337 | 无，且用 `site-shell fr-shell` 覆盖网格 |

七个位置一字排开写 `<div className="site-shell">…<Sidebar/>…<main className="content">…` —— 这就是阶段 B 要收敛的东西。

### 1.3 与审查报告的差异记录（以代码为准）

| 审查报告写法 | 实测 | 处理 |
| --- | --- | --- |
| 死 token 区块 `globals.css:1883-1990` | 令牌定义实际是 **1883-1979**，1981-1990 是 `@keyframes ui-spin/ui-pulse`（`components/ui/Button.tsx:88` 在用） | 本方案按 1883-1979 计，58 个 token |
| 未使用 CSS 类「18 个」 | 粗扫 18–31 个，差异来自 `is-active`/`active`/`in`/`lv3` 这类 JS/三元拼接 | 阶段 C 逐个复核后再删 |
| `--radius` 只用 1 次 | 确认：只有 `globals.css:235` | 保留但需补刻度 |
| 内联样式 48 处 | 48 = 前台 13 + `app/admin` 16 + `components/admin` 12 + `components/ui` 7 | 阶段 C 只动前台 13 处 |
| 双滚动条 | `.toc-col` 的 `max-height+overflow-y` 确认是唯一嵌套滚动容器 | 阶段 A |

> 本次还新发现 3 个审查报告未记录的问题，分别落在 **A-2 / A-3**（`hits.day` 双格式）和 **B-6**（移动端搜索页无输入框）。

### 1.4 本次核对到的**新问题**（比审查报告更严重）

**（1）`hits.day` 存在两种格式，且互相干扰**
- `lib/visitor-stats.ts:230` 用 `dateKeyIn()` 写入 → `2026-9-8`（不补零）
- `scripts/import-umami-events.mjs:179` 用 `createdUtc.slice(0,10)` 写入 → `2026-09-08`（补零）

两者并存后，`WHERE day >= ?` 的字符串比较全面失真。实测（模拟 10 月 31 日打开后台「访客」页）：

```
today 窗口起点 2026-10-31 -> 命中 2026-10-31, 2026-8-20, 2026-8-5, 2026-9-29, 2026-9-3, 2026-9-30
```

即「今天」把 8 月、9 月的数据全算了进去（因为 `'2026-8-5' >= '2026-10-31'` 为 `true`）。

**（2）`getDailySeries` 的 14 天柱状图对导入数据永远为 0**
`lib/visitor-stats.ts:341-353` 先用 `dateKeyIn()` 生成 key（不补零），再拿它去 `Map.get()` 查 DB 原值（导入的补零形态）→ 永不相等。实测：DB 里 `2026-09-08` 与 `2026-9-8` 两行，key 为 `2026-9-8` → 只有后者命中。

**（3）`.content-search` 在 ≤820px 被隐藏，正好命中搜索页自己的表单**
`globals.css:1294-1296` 的 `.content-search{display:none}` 本意是隐藏首页那个装饰性搜索框，但 `app/search/page.tsx:31` 的 `<form className="content-search">` 是**该页唯一的搜索输入**。移动端访问 `/search` 会看到没有输入框的结果页。

---

## 2. 重构目标与边界

### 2.1 四个阶段的一句话目标

| 阶段 | 目标 | 完成后的状态 |
| --- | --- | --- |
| A | 把「已经坏掉」的东西修对 | 归档 1–12 月标签全部正确、排序正确、访客统计区间正确、右栏不再独立滚动、reduced-motion 真的生效 |
| B | 把「复制粘贴」收敛成「一处定义」 | 7 处骨架 → 1 个 `SiteShell`；5 处 `max-width` 公式 → 1 个 `--w-shell`；2 份导航数组 → 1 份；友链页左栏偏移 = 0 |
| C | 把「样式泥潭」整理成「有刻度的系统」 | 令牌有定义也有使用、暗色只写一份、主题状态全局一致、`.nav a` 冲突消失、重复组件合并 |
| D | 在稳定地基上做**视觉**改版 | 首页 → 关于 → 友链 → 说说 → 辅助页，逐页验收 |

### 2.2 明确不做

- 不换框架、不引入 Tailwind 工具类（Preflight 保留，但不再扩大用途）
- 不引入 UI 组件库 / 图表库 / CSS-in-JS
- 不改 SQLite 表结构（除 A-3 的数据归一化，不新增业务列）
- 不改评论系统（Artalk）、不改 `pageKey`、不改 Artalk 容器结构
- 不重做友链页（需求文档 6.1 明确「只做局部优化，不允许推翻重做」）
- 不在阶段 A/B/C 里改视觉风格（颜色、圆角、字号整体调性一律留到 D）

### 2.3 阶段准入/准出

| 阶段 | 准出条件（全部满足才进入下一阶段） |
| --- | --- |
| A | `npm test` 绿 + `npx tsc --noEmit` 绿 + `npm run test:integration` 绿 + 归档页覆盖 1–12 月的标签逐个核对 + 备份可恢复演练一次 |
| B | 上述 + 新增的 10 视口布局断言全绿 + 每页截图与基线对比（除布局位移外无视觉变化） |
| C | 上述 + `test:dark` / `test:ui` / `test:admin` 绿 + 设计令牌测试扩到「定义必被引用」 |
| D | 上述 + 每页桌面/移动、明/暗共 4 张截图评审通过 + 需求文档第十二节逐条勾选 |

---

## 3. 问题分类与优先级

| 级别 | 定义 | 任务 |
| --- | --- | --- |
| **P0** 阻断 | 用户可见的功能错误 / 可访问性硬伤 | A-1 归档 NaN 月、A-2 访客区间失真、A-3 hits 归一化、A-4 右栏独立滚动、A-5 reduced-motion |
| **P1** 结构 | 阻碍后续改版的架构问题 | B-1 SiteShell、B-2 `--w-shell`、B-3 断点、B-4 友链页、B-5 双 Footer、B-6 搜索页、B-7 导航单源 |
| **P2** 质量 | 可维护性 / 一致性 / 重复代码 | C-1…C-9 |
| **P3** 视觉 | 需求文档里的设计目标 | D-1…D-5 |

映射到审查报告 26 条清单：报告 #1-#5 → A；#6-#14 → B；#15-#26 → C。报告 #20（内联样式）拆到 C-5（前台 13 处），后台的 28 处不在本次范围。

---

## 4. 全局技术决策（先定，再动手）

> 每条都给出**默认方案**（未获回复时按此执行）、备选方案与选择理由，并在标题下方标注风险等级。
> **这 8 条需要你确认**（对应第 13 节 Q1–Q11 中的相关项，编号 TD-1…TD-8）。
> ⚠️ 编号说明：本章编号是 **TD-**（Technical Decision），**不要与阶段 D 的视觉任务 D-1…D-5 混淆**。

### TD-1 日期键统一为「补零 ISO 日期」

> 🔴 **风险：数据口径** —— 改的是全站日期基准。补零本身不改「哪一天」，但会改变 `hits.day` 的写入形态，因此必须与 TD-2 同批推进。

**默认方案**：`lib/time.ts` 新增 `isoDateIn(v, tz)`，用 `en-CA` 的 `formatToParts` 输出 `YYYY-MM-DD`；`dateKeyIn` 改为它的别名（或直接改实现），`monthKeyIn` = `slice(0,7)`、`yearKeyIn` = `slice(0,4)` 自然变成 `2026-08` / `2026`。

**理由**：
1. **字符串比较才等价于时间比较**。这是 `WHERE day >= ?`（`lib/visitor-stats.ts:293/344`）能成立的前提。实测 `'2026-8-5' >= '2026-10-31'` 为 `true`，未补零时任何区间查询都会误命中。
2. **`monthKeyIn` 变成 `2026-08` 后 `Number(ym.slice(5,7))` 才安全**，`localeCompare` 排序也才等价于时间序。
3. **`new Date("YYYY-MM-DD")` 的语义由 ECMA-262 固定为 UTC**，不再受运行时 TZ 影响。实测（Node 22.23.3）：

```
TZ=UTC               "2026-08-05" -> 2026-08-05T00:00:00.000Z   ✅
                     "2026-8-5"   -> 2026-08-05T00:00:00.000Z   （UTC 下侥幸正确）
TZ=Asia/Shanghai     "2026-08-05" -> 2026-08-05T00:00:00.000Z   ✅
                     "2026-8-5"   -> 2026-08-04T16:00:00.000Z   ❌ 早一天
TZ=Pacific/Kiritimati "2026-08-05" -> 2026-08-05T00:00:00.000Z  ✅
                     "2026-8-5"   -> 2026-08-04T10:00:00.000Z   ❌ 早一天
```

也就是说：补零后跨 TZ 一致性由语言规范保证；不补零时只有 `TZ=UTC` 才碰巧对（生产 `deploy/blog.service:24` 恰好设了 `TZ=UTC`，属于侥幸而非设计）。

**备选（次选）**：只改 `lib/posts.ts` 的 label 与排序，不动 `dateKeyIn`。
- 优点：改动面最小，不碰 `hits`。
- 缺点：`/search` 与后台内容列表仍显示 `2026-8-5`；`getDailySeries` 的 key 与导入数据仍然不匹配；`hits` 的两种格式仍然并存。**问题只是从归档页挪到了别处。**

### TD-2 `hits.day` 用「新增迁移 0015」归一化，且**只补零、不重算日期**

> 🔴 **风险：数据迁移（不可逆）** —— 唯一会改写生产数据的决策。执行前必须：备份 → 副本 dry-run → 用户明确授权。详见 A-3 与第 0.2 节。

**默认方案**：新增 `0015_hits_day_isopad`，用**严格形状 + 日历有效性**双闸门，把未补零的 `day` 补零；**无法确定的行一律不动**，只输出待人工清单。配套 `scripts/normalize-hits-day.mjs` 做 dry-run 预览。

**理由**：
- 迁移框架本身逐条幂等、包在事务里、失败自动回滚（`lib/migrations.ts:607-614`），比"记得去服务器上跑脚本"可靠；
- 可重复执行：合规库再跑一次 `changes = 0`（实测）；
- 新装库天然是补零格式，迁移是空操作。

**五个必须写进迁移注释的约束**（每条都有实测依据，完整 SQL 见 A-3）：

1. **不能拿 `date(day)` 判断合法性**：SQLite 的 `date('2026-8-5')` 返回 `NULL`（只认两位月份），用它做条件会把**所有需要修的行**漏掉。
2. **不能拿 `date(created_at)` 重算 `day`**：`created_at` 是 UTC 口径、`day` 是 `DISPLAY_TZ` 口径。实测 `2026-10-01T18:00:00.000Z` → UTC 日 `2026-10-01`、上海日 `2026-10-02`。重算会把跨零点的行整体平移一天，而总量上完全看不出来。
3. **`date('2026-02-30')` 会静默进位成 `2026-03-02`**：SQLite 对不存在的日历日期不报错。所以 `date(cand) = cand` 只能当"是否合法"的**判断**用，**绝不能**把 `date(cand)` 的结果写回。
4. **`GLOB` 必须精确到结尾**：`'…-[0-9]*-[0-9]*'` 的 `*` 会匹配任意尾巴，把 `2026-8-5-9`、`2026-8-5 12:00:00` 截断成 `2026-08-05`——把格式错误"修"成一个看似正确的错值。正确写法是三条互斥的精确模式（见 A-3）。
5. **只 UPDATE，不 DELETE / INSERT**：行数守恒是硬要求；无法解析的行原样保留，由读取侧守卫（`day GLOB '…'`）排除。

**为什么不用 `CASE WHEN … THEN day ELSE <补零> END` 这种"一次写完"的形态**：那样会把 `ELSE` 分支套在**所有**不匹配的行上（含 `bogus`、空串），无法区分"能修的"和"必须人工看的"。拆成「严格条件 UPDATE」+「独立清单 SELECT」，两件事各自可测。

### TD-3 布局：单一 `--w-shell` + 三档模式，三栏阈值提到 1392px

> 🟠 **风险：布局 + 行为** —— 1201–1391 区间从三栏降为两栏，是可见行为变化。参数（288/800/320/40/1392）为设计决策，不得为通过测试而修改。

**默认方案**：

```css
:root {
  --w-side: 288px;
  --w-main: 800px;   /* 三栏中栏上限 */
  --w-toc:  320px;
  --gap-col: 40px;
  --w-read: 960px;   /* 两栏宽版正文上限（原友链页的 960） */
  --w-shell: calc(var(--w-side) + var(--w-main) + var(--w-toc) + var(--gap-col) * 2 + 64px); /* 1552px */
}
.site-shell { max-width: var(--w-shell); margin-inline: auto; padding-inline: 32px; }
/* 三栏：≥1392px（= 64 + 288 + 320 + 80 + 640） */
/* 两栏：821–1391px，中栏 max-width: var(--w-read) */
/* 单栏：≤820px */
```

**理由**：
- 今天 1200→1201 的断崖是「三栏硬塞进 1200」造成的：内容 760px 骤降到 **449px**。
- 把三栏门槛推到 1392（此时中栏刚好 640px，仍可读），1200 附近就不再有三栏，断崖消失。
- 关键不变量：**视口 ∈ [821, 1552] 时，任何页面的 `.sidebar` 左偏移恒为 32px**。友链页偏移问题自动消失，不需要在 `friends.css` 里重算 `max-width`。
- 两栏页的正文从 `--w-main`(800) 放宽到 `--w-read`(960)，是需求文档「友链页取消右栏后主内容可适当扩展」的落地。

**实测对照表（计算值，阶段 B 验收时用浏览器复核）**：

「标准页」= 首页/归档/说说/标签/文章（`variant="three-col"`，宽屏时带右栏）；
「宽版页」= 搜索/友链（`variant="wide"`，**永远两栏**，不随视口加右栏）。

| 视口 | 今天 中栏宽 | 方案：标准页 | 方案：宽版页 |
| --- | --- | --- | --- |
| 1600 | 800 | 三栏 800 | 两栏 960 |
| 1552 | 800 | 三栏 800 | 两栏 960 |
| 1440 | 688（实测） | 三栏 688 | 两栏 960 |
| 1392 | 640（计算） | 三栏 640（阈值） | 两栏 960 |
| 1391 | 639（计算） | 两栏 800 | 两栏 960 |
| 1352 | 600（计算） | 两栏 800 | 两栏 960（上限起点） |
| 1201 | **449（实测断崖）** | 两栏 800 | 两栏 809 |
| 1200 | 760（实测） | 两栏 800 | 两栏 808 |
| 1100 | 708（实测） | 两栏 708 | 两栏 708 |
| 900 | 508（实测） | 两栏 508 | 两栏 508 |
| 821 | 429（实测） | 两栏 429 | 两栏 429 |
| 820 | 780（实测） | 单栏 780 | 单栏 780 |
| 375 | 335（实测） | 单栏 335 | 单栏 335 |

> 算法：三栏中栏 `= min(--w-main, vw - 64 - 288 - 320 - 80)`；两栏中栏 `= min(上限, vw - 64 - 288 - 40)`，标准页上限 `--w-main`(800)、宽版页上限 `--w-read`(960)；单栏 `= vw - 40`。
> **唯一残留的跳变**：标准页 1391→1392 时中栏 800→640（加出右栏的代价），这是有意的单步台阶，不是断崖——640px 是舒适行宽的下限。今天的问题恰恰相反：1201 时中栏只有 449px，已经低于可读下限。
> **左栏位置**：视口 ∈ [821, 1552] 时，所有页面的 `.sidebar` 左偏移恒为 **32px**（今天首页 32 / 友链页 76）；> 1552 时整体居中。

> 唯一残留的不连续：1392→1391 时中栏 640→960（右栏消失换来的空间）。左栏位置不变，这是可接受的。

### TD-4 骨架用 `SiteShell` 组件，不用「纯 CSS 变体类」

**默认方案**：新增 `components/SiteShell.tsx`（服务端组件），API 固定为：

```tsx
<SiteShell variant="three-col" toc={toc}>{children}</SiteShell>
<SiteShell variant="wide" className="fr-main">{children}</SiteShell>
```

**理由**：
- 纯 CSS 变体解决不了「搜索页声明三列却没有第三列子元素」这种**结构错配**——它必须由 JSX 决定。
- 组件让「这一页有没有右栏」成为显式参数，而不是靠"有没有写那个 div"。
- 不做过度抽象：**只有 3 个 variant，不接受任意 grid 字符串**；不接管 `Animations`、不接管 `<main>` 内部结构。

**备选**：只在 CSS 里加 `.site-shell--2col / --3col`。缺点：仍然要 7 处手写 `<div>`，且第三列的存在与否仍然靠自觉。

### TD-5 导航单源：`lib/nav.ts` + `Sidebar` 内置 `usePathname`

**默认方案**：

```ts
// lib/nav.ts（新增，纯数据，无 "use client"）
export type NavItem = { href: string; label: string; icon: string };
export const NAV_ITEMS: NavItem[] = [
  { href: "/",             label: "文章", icon: "📄" },
  { href: "/shuoshuo",     label: "说说", icon: "💬" },
  { href: "/archives",     label: "归档", icon: "🗂" },
  { href: "/friend-links", label: "友链", icon: "🔗" },
  { href: "/about",        label: "关于", icon: "👤" },
];
export function activeHref(pathname: string): string | null; // /p/*、/tags/* → "/"
```

`components/Sidebar.tsx` 加 `"use client"`，删掉 `active` prop；`MobileNav` 保留 `usePathname` 但改读同一数组。

**理由**：`active` 是手工字符串，已经漏了 3 个页面（`/about`、`/tags/*`、`/search`）。改成路由自判是唯一不会再漏的做法。

**代价与取舍**：`Sidebar` 从服务端组件变成客户端组件，会多带一点 JS（数组 5 条 + 两个图标字符串）。实测成本可忽略，但它已经 import 了两个客户端组件（`SidebarTrigger` / `ThemeToggle`），并非纯静态。

**注意**：`Sidebar` 目前是 async 无关的（没有 await），可以直接加 `"use client"`。`RightBar` / `FriendLinks` / `MobileSidebarContent` 是 async 服务端组件，**不能**跟着变客户端。

### TD-6 标签文案统一为「文章 / 说说 / 归档 / 友链 / 关于」

> 🟡 **风险：视觉/文案** —— 移动端两处标签与顺序会变。

现状：`Sidebar.tsx:5-11` 是 文章/说说/归档/友链/关于（顺序 A），`MobileNav.tsx:9-15` 是 首页/归档/说说/朋友/关于（顺序 B）。
**默认方案**：统一到 A：与需求文档 2.1 的列表顺序一致，也与站点语义一致。

**这是一次可见文案变更**（移动端「首页」→「文章」、「朋友」→「友链」），需要你确认（Q3）。

### TD-7 令牌策略：先删死令牌，再按需新增

> 🟡 **风险：视觉/结构** —— 删 97 行零引用 token。已核对无字符串拼接引用。

**默认方案**：`globals.css:1883-1979` 的 58 个 token（`--space-*`/`--radius-*`/`--fs-*`/`--lh-*`/`--fw-*`/`--btn-*`/`--field-*`/`--table-*`/`--skeleton-*`/`--toast-*`）**先整体删除**，然后按本次真正用到的清单逐个加回：

必须加回的（阶段 B/C 会真用）：`--w-shell`、`--w-read`、`--sticky-top`、`--radius-sm/md/lg`、`--fs-xs/sm/base/lg`、`--dur-fast/base`、`--z-topbar/drawer/dialog`。

**理由**：100% 未被引用的 58 个 token 是「看起来已经抽象、实际零生效」的死代码（实测 `var()` 引用 0 处，名字在其它文件里也搜不到）。保留它们会让后来者以为系统已经建立。

### TD-8 主题状态：共享 `data-theme`，不引入全局 store

> 🟠 **风险：首屏防闪烁** —— 改动 `ThemeToggle` 时不得动 `ThemeScript` 的内联脚本时序。

**默认方案**：`ThemeToggle` 改为 `useSyncExternalStore` 订阅 `document.documentElement` 的 `data-theme` 属性（`MutationObserver` 作为 subscribe 实现），组件本身不再持有 `theme` state。

**理由**：页面上有 2 个实例（`Sidebar.tsx:56`、`MobileNav.tsx:94`），后台还有 2 个（`AdminShell.tsx:204/216`）。现在它们各自持有 state，实测点一次后另一个实例的 `aria-label` 仍是旧文案（读屏用户会听到错误提示）。`MutationObserver` 已在 `CommentSection.tsx:141` 用过同一手法，不引入新范式、不引入依赖。

---

## 5. 阶段 A：基础 Bug 修复

### A.1 阶段目标

把三件「用户能看见的错」和三件「已经坏掉但没被发现」的东西修对，同时**不碰任何视觉**。完成后：

- `/archives` 里 1–12 月的月份标签全部是 `N 月`（不再是 `NaN 月`），同年内严格倒序；
- 后台「访客」页的今天/7 天/30 天不再把 8 月的记录算进来；
- 14 天柱状图能显示导入的历史数据；
- 右栏不再有自己的滚动条；
- 系统开启「减少动态效果」时，全站过渡真的被压到 0.01ms。

### A.2 任务

---

#### A-1 归档月份标签与排序（P0）

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `lib/time.ts`、`lib/posts.ts`、`tests/time.test.ts`（改）、`tests/posts-api.test.ts`（改） |
| **当前问题** | `lib/time.ts:74-80` 的 `dateKeyIn` 用 `Intl` 的 `month:"numeric"`/`day:"numeric"`，**月和日都不补零** → `2026-8-5`。`lib/posts.ts:159` `monthKeyIn` 取 `slice(0,7)` 得 `2026-8-`，`lib/posts.ts:171` 的 `Number("8-")` 就是 `NaN`。实测：`dateKeyIn("2026-08-05T02:00Z")` = `2026-8-5`、`"2026-11-01T02:00Z"` = `2026-11-1`。<br>**影响面**：① 1–9 月标签变 `NaN 月`（10–12 月月份恰好两位，标签正常）；② **日也不补零**，归档条目日期渲染成 `8/5` 而不是需求文档 8.3 要求的 `08/05`；③ `2026-8-`/`2026-9-`/`2026-10` 的 `localeCompare` 降序是 `['2026-9-','2026-8-','2026-10']` → 10 月被排到最后 |
| **计划修改** | 1) `lib/time.ts` 新增 `isoDateIn(v, tz)`：用 `Intl.DateTimeFormat("en-CA", {year:"numeric",month:"2-digit",day:"2-digit",timeZone})` 输出 `YYYY-MM-DD`；2) `dateKeyIn` 内部改调它（保持导出名不变，避免 8 处调用点全改）；3) `monthKeyIn`/`yearKeyIn` 保持 slice 实现（补零后天然正确）；4) `lib/posts.ts:155-164` 分组前跳过空 key：`if (!y \|\| !ym) continue;`，并在 `process.env.NODE_ENV !== "production"` 时 `console.warn` 一条带 post.id 的日志；5) `lib/posts.ts:171` label 改用 `Number(ym.slice(5,7))`（此时安全），排序保持 `localeCompare`（此时等价于时间序） |
| **预期效果** | 1–12 月的标签全部是 `N 月`；同一年内月份严格倒序；条目日期补零为 `MM/DD`；非法日期不再产生 `year=""` 的空分组 |
| **潜在影响** | `dateKeyIn` 的输出格式变了，全部 **8 处调用点**已逐一核对：`app/archives/page.tsx:48`（`slice(5)` 后显示，补零后变 `08/05`）、`components/admin/ContentView.tsx:138`（后台列表只显示）、`lib/search.ts:48,97`（喂给 `PostCard.formatDate`）、`lib/visitor-stats.ts:230`（写 `hits.day`，需 A-2/A-3 同步）、`:287`（区间起点）、`:341,350`（14 天图表的 key）。前 4 处补零后**更**正确；后 4 处必须与 A-2/A-3 同批处理 |
| **风险等级** | **高**（8 个调用点 + 改变 `hits.day` 写入格式） |
| **验收标准** | ① `tests/time.test.ts` 新增：`dateKeyIn("2026-08-05T02:00:00Z","Asia/Shanghai") === "2026-08-05"`、`dateKeyIn("2026-01-03T02:00:00Z",…) === "2026-01-03"`、`monthKeyIn(...) === "2026-08"`、`dateKeyIn("2026-11-01T02:00:00Z",…) === "2026-11-01"`；② `tests/posts-api.test.ts` 新增：插入 1/8/9/10/11 月各一篇，断言 `listArchives()` 的 `months.map(m=>m.label)` 等于 `["11 月","10 月","9 月","8 月","1 月"]`；③ 浏览器 `1440×900` 打开 `/archives`：页面文本 `NaN` 出现 0 次，且每条 `.archive-item .date` 匹配 `/^\d{2}\/\d{2}$/` |
| **依赖** | 无（但**必须先写测试**：先加断言跑红，再改实现跑绿） |

**为什么先写测试**：现有 `tests/time.test.ts:35` 只断言 `2026-10`（恰好两位），所以这个 bug 活了很久。新测试必须覆盖 `01/08/09/11` 四个月份，其中 01/08/09 验证补零，11 验证"两位数月份不被误伤"。

---

#### A-2 `hits.day` 读写口径统一（P0，新增发现）

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `lib/visitor-stats.ts`、`scripts/import-umami-events.mjs`、`tests/visitor-stats.test.ts`（改） |
| **当前问题** | 两个写入者用两种格式：`lib/visitor-stats.ts:230` 走 `dateKeyIn`（不补零）、`scripts/import-umami-events.mjs:179` 走 `slice(0,10)`（补零）。读取侧 `whereFor`（`:293`）与 `getDailySeries`（`:344`）都做字符串 `>=` 比较。实测：`today` 窗口会把 8 月、9 月的行全部算进"今天"；14 天柱状图对导入数据恒为 0 |
| **计划修改** | 1) A-1 完成后 `dateKeyIn` 已补零 → 实时写入自动变正确；2) `scripts/import-umami-events.mjs:179` 改为调用同一个 `isoDateIn`（或保持 `slice` 并在注释里注明"必须与 lib/time 的 isoDateIn 同口径"）；3) `whereFor` 不改（补零后字符串比较正确）；4) 在 `lib/visitor-stats.ts` 顶部加一段注释，写死「`day` 必须是补零 `YYYY-MM-DD`，两种写入者共用 `isoDateIn`」 |
| **预期效果** | 今天/7d/30d 只统计真实区间；14 天图表能显示历史导入数据 |
| **潜在影响** | 统计数字会**变小**（今天是修复，不是回归）。上线后第一天的"今天"读数可能明显低于历史，需要在发布说明里写清楚 |
| **风险等级** | **高**（历史数据 + 用户最容易察觉的数字变化） |
| **验收标准** | 新增测试（四条，**互不重叠**）：<br>① **写入格式**：调用 `recordHit({path:"/about", ip:"1.1.1.1", ua:"Mozilla/5.0 Chrome/120"})`，然后读 `hits` 最新一行，断言 `day` 匹配 `/^\d{4}-\d{2}-\d{2}$/`。这是**回归护栏**，不是发现该 bug 的测试：它只在「今天恰好是 1–9 月」时才可能失败，所以必须靠 A-1 里**固定日期**的 `isoDateIn` 用例锁死补零行为——依赖「跑测试那天是几月」的断言是脆弱的。<br>② **区间参数**：断言 `whereFor("today"｜"7d"｜"30d")` 的 `args[0]` 匹配 `/^\d{4}-\d{2}-\d{2}$/`。（`whereFor` 目前是模块私有函数；实施时改为 `export` 供测试，或用 `getSummary` 的返回间接验证，二选一，不要为测试拆无意义的公开 API。）<br>③ **区间边界**：插入一条 60 天前的记录（`day = isoDateIn(60 天前)`），断言 `getSummary("today")` 与 `getSummary("7d")` 的 `pvLocal` 都不含它，而 `getSummary("all")` 含它。<br>④ **混合格式不再产生假命中**：插入一条 `2026-8-5` 形态的**历史遗留行**（手工构造，不经过 `dateKeyIn`），断言它不计入 `getSummary("7d")`。**注意**：这条要等 A-3 迁移跑完后才成立；A-2 阶段先加为 `test.todo` 或放在 A-3 的用例里，避免顺序耦合。 |
| **依赖** | **依赖 A-1**（`dateKeyIn` 补零后才能保证新写入合规）。A-2 与 A-3 必须**同一批次**交付，但 A-2 自身不能跳过 A-1 先做（否则新写入仍是旧格式） |

---

#### A-3 迁移 `0015_hits_day_isopad`（P0）

> ⚠️ **本任务是全文档唯一会改写生产数据的任务。**
> 迁移代码、dry-run 脚本、测试都可以在本地完成；**但"在生产库上执行迁移"必须由你明确授权**（详见第 0.2 节与第 12.2 节）。Agent 不得自行连生产库、不得自行跑 `--apply`、不得自行部署。

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `lib/migrations.ts`（新增 0015）、`scripts/normalize-hits-day.mjs`（**新增**，dry-run 默认 + `--apply`）、`tests/migrations.test.ts`（改） |
| **当前问题** | ① 线上 `hits.day` 混有 `2026-8-5`（`recordHit` 写入）与 `2026-09-08`（Umami 导入脚本写入）两种形态，字符串比较全面失真；② 现有草稿里的 `day GLOB '…-[0-9]*-[0-9]*'` 条件**过宽**：`2026-8-5-9`、`2026-8-5 12:00:00` 都会被 `*` 吞掉并截断成 `2026-08-05`，等于把一个格式错误的值"修"成一个看似正确的错误日期 |
| **计划修改** | 迁移只做**一件事**：把**形状严格匹配且日历合法**的未补零日期补零。其余一律**不动**，只记录成待人工清单。共三段（见「A-3 实现细节」）：① 严格形状 + 日历有效性双闸门后补零（UPDATE）；② 生成「需要人工核对」清单（只读 SELECT，不写库）；③ 读取侧加**形状守卫**，让未补零/垃圾值不参与字符串比较（注意：守卫**不判日历合法性**，详见细节） |
| **预期效果** | 合法未补零行 100% 变成 `YYYY-MM-DD`；重复执行 `changes = 0`；**任何无法确定的行都保持原值**，不会被猜成某个日期；空表 / 无 `hits` 表时静默跳过 |
| **潜在影响** | ① 数据不可逆（只能靠备份恢复）；② 会连带修改 `lib/visitor-stats.ts` 的读取条件（加形状守卫），影响后台「访客」页四个数字；③ **执行前必须**：由你确认是否执行/在哪台机器执行、跑 `blog-backup` 并校验 `PRAGMA integrity_check`、在备份副本上 dry-run 核对行数；④ 迁移包在 `migrate()` 的事务里，失败自动回滚 |
| **风险等级** | **高**（唯一改写生产数据 + 不可逆 + 影响后台全部统计口径） |
| **验收标准** | 见下方「A-3 测试矩阵」，**T1–T20 全部覆盖**；其中 **T6–T15 共 10 类异常/脏数据**（非数字月份、非数字日、非法日历日、越界月、越界日、空字符串、纯空格、带时间、多段、垃圾串）必须断言「保持原值」 |
| **依赖** | 依赖 A-1（`dateKeyIn` 补零）。**必须与 A-2 同一批次上线**（否则写入新格式、旧数据还是旧格式） |

**A-3 实现细节**

**为什么不能用 `date(day)` 或 `date(created_at)` 直接重写**

三个实测结论（`better-sqlite3` 12.11.1 / SQLite 3.53.2）：

1. `date('2026-8-5')` → `NULL`。SQLite 的日期函数只认两位月份，所以**不能**用它来判断"未补零的行是否合法"。
2. `date('2026-02-30')` → `'2026-03-02'`，`date('2026-04-31')` → `'2026-05-01'`。SQLite 对**日历上不存在的日期会静默进位**，不报错。所以 `date(x) = x` 是一个可用的"日历有效性"判断（进位后必然不等于原值），但**绝不能**把 `date(x)` 的结果直接写回 `day`。
3. `date(created_at)` 是 **UTC 口径**，而 `day` 是 **`DISPLAY_TZ`（默认 Asia/Shanghai）口径**。实测 `2026-10-01T18:00:00.000Z` → UTC 日 `2026-10-01`、上海日 `2026-10-02`。所以用 `created_at` 重算 `day` 会**把日期平移一天**，且总量上看不出来。

→ 结论：**迁移只补零，不重算日期**。补零前后"是哪一天"必须完全不变。

**第一段：严格形状 + 日历有效 → 补零（幂等）**

```sql
UPDATE hits
   SET day = printf('%s-%02d-%02d',
             substr(day, 1, 4),
             CAST(substr(day, 6, instr(substr(day, 6), '-') - 1) AS INTEGER),
             CAST(substr(day, 6 + instr(substr(day, 6), '-')) AS INTEGER))
 WHERE (
         day GLOB '[0-9][0-9][0-9][0-9]-[0-9]-[0-9]'
      OR day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9]'
      OR day GLOB '[0-9][0-9][0-9][0-9]-[0-9]-[0-9][0-9]'
       )
   AND day <> printf('%s-%02d-%02d',
             substr(day, 1, 4),
             CAST(substr(day, 6, instr(substr(day, 6), '-') - 1) AS INTEGER),
             CAST(substr(day, 6 + instr(substr(day, 6), '-')) AS INTEGER))
   AND date(printf('%s-%02d-%02d',
             substr(day, 1, 4),
             CAST(substr(day, 6, instr(substr(day, 6), '-') - 1) AS INTEGER),
             CAST(substr(day, 6 + instr(substr(day, 6), '-')) AS INTEGER)))
       = printf('%s-%02d-%02d',
             substr(day, 1, 4),
             CAST(substr(day, 6, instr(substr(day, 6), '-') - 1) AS INTEGER),
             CAST(substr(day, 6 + instr(substr(day, 6), '-')) AS INTEGER));
```

四个闸门缺一不可：

| 闸门 | 作用 | 去掉会怎样 |
| --- | --- | --- |
| `GLOB` 三条**精确形状** | 只接受 `YYYY-M-D` / `YYYY-MM-D` / `YYYY-M-DD`，且**必须在此结束** | 旧写法 `'…-[0-9]*-[0-9]*'` 里的 `*` 会匹配任意尾巴，`2026-8-5-9`、`2026-8-5 12:00:00` 会被截断成 `2026-08-05` |
| `day <> printf(...)` | 已经是补零形态的行不参与 | 第二次执行会重复 UPDATE，`changes` 永远不为 0，迁移不再幂等 |
| `date(cand) = cand` | 日历有效性：`2026-2-30` → `2026-02-30` → `date()` 进位成 `2026-03-02` ≠ 候选值 → **拒绝** | `2026-2-30` 会被写成 `2026-02-30` 这个**不存在的日期**，之后所有按月分组都会带着它 |
| （隐含）不碰 `created_at` | 日期口径不变 | 跨零点记录被平移一天 |

**第二段：生成待人工清单（只读，不写库）**

迁移本身**不修**脏数据。`scripts/normalize-hits-day.mjs` 在 dry-run 下输出这份清单，人工决定怎么处理：

```sql
-- 「既不合法、也不在可自动修复集合」的行：全部列出来
SELECT id, day, created_at, path
  FROM hits
 WHERE NOT (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
            AND date(day) IS day)
 ORDER BY id;
```

**第三段：读取侧守卫（防脏行污染统计）**

即使库里有脏行，读取侧也不能把它们算进任何区间。`whereFor` 与 `getDailySeries` 的条件改为：

```sql
-- 以 whereFor 为例：在原有条件前叠加形状守卫
WHERE day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  AND day >= ?
```

**这条守卫能拦什么、不能拦什么**（已实测，别高估它）：

| 输入 | 被挡住？ | 原因 |
| --- | --- | --- |
| `2026-8-5`（未补零） | ✅ | 不匹配 10 位固定形状 |
| `bogus`、`''`、`'  '` | ✅ | 同上 |
| `2026-13-01`、`2026-00-10` | ❌ 拦不住 | 十位数字、两条连字符，形状完全合法；GLOB 不管月份范围 |
| `2026-02-30`、`2026-04-31`（日历不存在但形状合法） | ❌ 拦不住 | 同上；需要 `date(day) IS day` 才能判，而那是函数调用 |

> 上表后两行是实测结论：`GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'` **只校验「十位、数字、两条连字符」，不校验月份/日是否在合法区间**。实测 `2026-13-01` 与 `2026-02-30` 都能通过这条 GLOB。
> 因此守卫的定位是**"挡住会破坏字符串比较语义的脏值"**，不是"保证日期在日历上存在"。日历合法性只能靠迁移筛（A-3 第一段）+ 人工清单兜。
> 若要把月份/日范围也压进索引可用的条件里，可叠加 `substr(day,6,2) BETWEEN '01' AND '12' AND substr(day,9,2) BETWEEN '01' AND '31'`（实测仍走 `COVERING INDEX`），但它依然拦不住 `2026-02-30`。**本方案不强制加这两条**，因为迁移后形状守卫已足够；加不加由 A-3 实施时按实际脏数据决定。

性能方面：`GLOB` 是纯字符串匹配、无函数调用，**不会让 `idx_hits_day` 失效**（实测执行计划为 `SEARCH hits USING COVERING INDEX idx (day>?)`）；`date(day) IS day` 这类函数调用才会，所以只在迁移脚本里用，不放进查询。

**实测样例（迁移前后）**

| # | 原 day | 形状闸门 | 日历闸门 | 迁移后 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | `2026-8-5` | ✅ | ✅ | `2026-08-05` | 正常补零 |
| 2 | `2026-8-05` | ✅ | ✅ | `2026-08-05` | 补月 |
| 3 | `2026-08-5` | ✅ | ✅ | `2026-08-05` | 补日 |
| 4 | `2026-9-30` | ✅ | ✅ | `2026-09-30` | **保持 09-30**，不被 `created_at` 的 UTC 日改写 |
| 5 | `2026-10-30` | —（已合规） | — | `2026-10-30` | 不动 |
| 6 | `2026-2-30` | ✅ | ❌ 进位成 `03-02` | `2026-2-30` | **拒绝**，进待人工清单 |
| 7 | `2026-4-31` | ✅ | ❌ 进位成 `05-01` | `2026-4-31` | **拒绝** |
| 8 | `2026-13-01` | ✅ | ❌ `date()` 返回 NULL | `2026-13-01` | **拒绝** |
| 9 | `2026-00-10` | ✅ | ❌ NULL | `2026-00-10` | **拒绝** |
| 10 | `2026-ab-05` | ❌ 非数字 | — | `2026-ab-05` | 不匹配，保持原值 |
| 11 | `2026--05` | ❌ | — | `2026--05` | 保持原值 |
| 12 | `2026-8-` | ❌ 尾部缺日 | — | `2026-8-` | 保持原值 |
| 13 | `2026-8-5-9` | ❌ 多一段 | — | `2026-8-5-9` | **旧写法会误改成 `2026-08-05`** |
| 14 | `2026-8-5 12:00:00` | ❌ 带时间 | — | `2026-8-5 12:00:00` | **旧写法会误改成 `2026-08-05`** |
| 15 | `abcd-ef-gh` | ❌ | — | `abcd-ef-gh` | 保持原值 |
| 16 | `""`（空串） | ❌ | — | `""` | 保持原值，进清单 |
| 17 | `"  "`（纯空格） | ❌ | — | `"  "` | 保持原值，进清单 |
| 18 | `bogus` | ❌ | — | `bogus` | 保持原值，进清单 |

实测汇总（18 行样本，SQL 原样粘贴自上方代码块）：第一段 `changes = 4`（#1/#2/#3 补零 + #4 `2026-9-30`→`2026-09-30`，日期本身不变），再跑两次均为 `changes = 0`；`2026-9-30` 的「日」仍是 `09-30`（未被 `created_at` 的 UTC 日改写成 `10-01`）；待人工清单 **13 行**（#6–#18）；`SELECT COUNT(*)` 迁移前后都是 18；`PRAGMA integrity_check` = `ok`。

**A-3 测试矩阵（`tests/migrations.test.ts` 必须逐条覆盖）**

| 用例 | 输入 | 断言 |
| --- | --- | --- |
| T1 正常补零 | `2026-8-5` | 变 `2026-08-05` |
| T2 只缺月 | `2026-8-05` | 变 `2026-08-05` |
| T3 只缺日 | `2026-08-5` | 变 `2026-08-05` |
| T4 跨月边界 | `2026-9-30` + `created_at=2026-10-01T18:00Z` | **仍是 `2026-09-30`**（不得被 UTC 日改写） |
| T5 已合规 | `2026-10-30` | 不变，且不计入 `changes` |
| T6 非数字月份 | `2026-ab-05` | 保持原值 |
| T7 非数字日 | `2026-8-xx` | 保持原值 |
| T8 非法日历日（小月） | `2026-2-30`、`2026-4-31` | 保持原值（**不得**变成 `03-02` / `05-01`） |
| T9 越界月 | `2026-13-01`、`2026-00-10` | 保持原值 |
| T10 越界日 | `2026-8-32`、`2026-8-00` | 保持原值 |
| T11 空字符串 | `''` | 保持原值 |
| T12 纯空格 | `'  '` | 保持原值 |
| T13 带时间 | `2026-8-5 12:00:00` | 保持原值（**不得**截断成 `2026-08-05`） |
| T14 多段 | `2026-8-5-9` | 保持原值 |
| T15 垃圾串 | `bogus`、`abcd-ef-gh` | 保持原值 |
| T16 幂等 | 连跑 3 次 | `changes` 依次为 `n / 0 / 0` |
| T17 空表 | `hits` 有表无行 | 不抛错，`changes = 0` |
| T18 无表 | 老库无 `hits` 表 | 迁移不抛错（`hasTable` 前置判断） |
| T19 完整性 | 跑完 `PRAGMA integrity_check` | `ok`；`PRAGMA foreign_key_check` 返回空 |
| T20 总数守恒 | 迁移前后 | `SELECT COUNT(*) FROM hits` 不变（只 UPDATE，不 DELETE/INSERT） |

> **本矩阵已用文档中的 SQL 原样验证**（`better-sqlite3` 12.11.1，19 行样本）：T1–T15 的期望值全部成立，`changes` 连跑三次为 `4 / 0 / 0`，行数守恒 19→19，`PRAGMA integrity_check` = `ok`，待人工清单 14 行。**故实施时的测试应与本文档逐字对应**：若某条断言不成立，先怀疑实现抄错，而不是改测试。

**生产执行前置条件（缺一不可，且每一项都需要你显式同意）**

1. 你确认**要**在生产执行，并指定执行机器与时窗；
2. 执行 `/usr/local/bin/blog-backup`，确认新备份文件存在、大小合理、`PRAGMA integrity_check` = ok；
3. 把备份复制到临时目录，用 `scripts/normalize-hits-day.mjs` 跑 dry-run，把「将修改 N 行 / 待人工 M 行」的数字给你确认；
4. 你确认数字后，才允许部署并让 `migrate()` 在首个请求时应用 0015；
5. 部署后立刻对比 `/admin/visitors?range=all` 的 PV 与部署前**完全一致**（`all` 不按 `day` 过滤，PV 必须不变——这是最强的正确性信号）；
6. 若 PV 变了或任一页面异常 → 立即 `deploy.sh --rollback` + 用备份恢复库，并把现象记录下来。

---

#### A-4 右栏独立滚动（P0）

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `app/globals.css`（547-553） |
| **当前问题** | `.toc-col{ position:sticky; top:48px; max-height:calc(100vh - 96px); overflow-y:auto }`。18 条友链时实测 `clientHeight 704 / scrollHeight 1647`，滚轮在右栏内滚动的是右栏（`tocScrollTop 0→600`），页面不动 → 两个滚动区抢滚轮 |
| **计划修改** | 1) `.toc-col` 删除 `max-height` 与 `overflow-y`，只保留 `position:sticky; top:var(--sticky-top)`；2) 目录本身在超长时单独滚动：`.toc-list{ max-height: calc(100dvh - var(--sticky-top) - 96px); overflow-y:auto; overscroll-behavior:contain }`；3) 新增 `--sticky-top: 40px`，`.sidebar`（`:191`）与 `.toc-col`（`:549`）都改用它（现在 40/48 不齐） |
| **预期效果** | 右栏随页面滚动；只有"目录"在超长时才独立滚动，且带 `overscroll-behavior:contain` 不把滚动链传给页面 |
| **潜在影响** | 右栏很高时会被页面滚走（这是需求文档「默认使用整个页面统一滚动」的期望行为）。若有人习惯"右栏常驻"，观感会变 |
| **风险等级** | 中 |
| **验收标准** | 新增浏览器断言（阶段 B 会一并做成 `tests/layout-regression.mjs`）：在 1440×900 下遍历所有元素，断言 `overflow-y:auto\|scroll && scrollHeight>clientHeight+1` 的可见容器数量 = 0（友链 ≥12 条时）；再断言 `.sidebar` 与 `.toc-col` 的 `getComputedStyle(...).top` 相等 |
| **依赖** | 无 |

---

#### A-5 恢复 `prefers-reduced-motion` 全局块（P0）

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `app/globals.css`（1815-1823） |
| **当前问题** | 第 1815 行 `/* ═════…` 只有 `/*` 没有 `*/`，把 1816-1823 的整个 `@media (prefers-reduced-motion: reduce)` 吞进注释，直到 1829 才闭合。实测 `globals.css` 注释符 142 开 / 141 闭（唯一一处不平衡）；构建产物里 globals chunk 的 `animation-duration:.01ms` 出现 0 次，admin chunk 出现 1 次；`reducedMotion:"reduce"` 下 `.theme-toggle` 的 `transitionDuration` 仍是 `0.16s` |
| **计划修改** | 把 1815 行改成完整的注释头（补 `══════ */`），让 `@media` 落回规则区。**不要删掉这段**（它是有用的） |
| **预期效果** | 系统开启「减少动态效果」时全站动画/过渡被压到 0.01ms；`.slide-up` 直接显示 |
| **潜在影响** | 只有开启该偏好的用户观感变化（这正是目的）。普通用户无变化 |
| **风险等级** | 低 |
| **验收标准** | ① 新增断言：解析 `globals.css` 的 `/*` 与 `*/` 数量相等（可做成 `tests/css-health.test.ts`，同时守住"以后别再漏闭合"）；② 浏览器：`newContext({ reducedMotion: "reduce" })` 下断言 `.theme-toggle` 与 `.post-card` 的 `transitionDuration` ≤ `0.001s`；③ 普通上下文断言过渡仍是 `0.15~0.2s`（防止把"压缩"写成全局） |
| **依赖** | 无 |

---

#### A-6 阶段 A 的回归与收尾

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `docs/frontend-refactor-roadmap.md`（如需记录差异）；无源码改动 |
| **动作** | 1) `npm test`（282 + 新增用例全绿）；2) `npx tsc --noEmit`；3) `npm run build`；4) `npm run test:integration`；5) 手工核对 `/archives` 1–12 月标签与排序、条目日期为 `MM/DD`；6) 手工核对 `/admin/visitors?range=today\|7d\|30d\|all` 四个数字；7) **在备份副本上演练一次恢复流程**（第 12.2 节 (6)） |
| **提交要求** | A-1 / A-2 / A-3 / A-4 / A-5 **各一个独立 commit**（如 `A-1: 日期键补零，修复归档 NaN 月`），不合并、不 squash |
| **验收标准** | 全部绿；`/archives` 无 `NaN`；`all` 区间 PV 与部署前一致；恢复演练通过 |
| **阶段结束动作** | **停下来等用户验收。** 输出：改了哪些文件、测试结果、`/archives` 与 `/admin/visitors` 截图、待人工清单（A-3 的 M 行）、下一步建议。**用户明确说"可以进阶段 B"之前，不得开始 B。** |
| **依赖** | **依赖 A-1…A-5 全部完成**（A-4/A-5 可与 A-1 并行，但都必须在本任务之前收尾） |
| **回滚** | 代码：`git revert` 单个 commit（不 squash，可精确回滚）。数据：按第 12.2 节 (2) 恢复备份（**需授权**） |

### A.3 文件修改清单（阶段 A）

| 文件 | 动作 | 任务 |
| --- | --- | --- |
| `lib/time.ts` | 改：新增 `isoDateIn`，`dateKeyIn` 改实现 | A-1 |
| `lib/posts.ts` | 改：`listArchives` 跳过空 key、label 从 key 取 | A-1 |
| `lib/visitor-stats.ts` | 改：`day` 口径统一 + 读取侧合法性守卫 + 注释 | A-2 / A-3 |
| `scripts/import-umami-events.mjs` | 改：`day` 改用同一生成器 | A-2 |
| `lib/migrations.ts` | 改：追加 `0015_hits_day_isopad` | A-3 |
| `scripts/normalize-hits-day.mjs` | **新增**：dry-run / `--apply` | A-3 |
| `app/globals.css` | 改：547-553（右栏滚动）、1815（补 `*/`）、新增 `--sticky-top` | A-4 / A-5 |
| `tests/time.test.ts` | 改：补 01/08/09/11 月用例 | A-1 |
| `tests/posts-api.test.ts` | 改：`listArchives` label 顺序断言 | A-1 |
| `tests/visitor-stats.test.ts` | 改：混合 day 格式断言 | A-2 |
| `tests/migrations.test.ts` | 改：0015 的 T1–T20 测试矩阵（含 T6–T15 共 10 类异常输入） | A-3 |
| `tests/css-health.test.ts` | **新增**：注释闭合 + reduced-motion 生效 | A-5 |

### A.4 执行顺序与依赖

```
A-1 ──┬──► A-2 ──► A-3 ──┐
      │                  ├──► A-6（本地收尾）
A-4 ──┤                  │
A-5 ──┘                  │
                         └──► 【GATE】生产上线（需授权，见 14.2）
```

| 关系 | 说明 |
| --- | --- |
| **必须串行** | A-1 → A-2 → A-3（三者共享同一日期口径，且 A-2 依赖 A-1 的补零、A-3 依赖 A-1 的格式） |
| **可并行** | A-4、A-5 与 A-1/A-2/A-3 之间（纯 CSS，与日期无关）；A-4 与 A-5 之间也互不影响 |
| **必须最后** | A-6 在 A-1…A-5 全部完成后执行 |
| **GATE** | A-6 通过 ≠ 上线。生产迁移/部署必须另行取得你的授权（14.2 的 5 步） |

> 之前的版本写"A-3 可以提前写骨架、apply 必须等 A-1"，容易让人以为可以先把 A-3 合入；**正确做法是 A-3 的代码与 A-1/A-2 一起合入同一批次**，本地可先把迁移代码写好但不要单独发布。

### A.5 阶段 A 回归测试

```bash
npm test                       # 单测（282 + 新增）
npx tsc --noEmit               # 类型
npm run build                  # 构建（standalone 必须成功）
npm run test:next              # HTTP 集成（缓存/308/搜索）
npm run test:integration       # 全量浏览器套件（约 10 分钟）
```

**人工检查**：
- `/archives`：1–12 月标签、年份分组、同年内倒序（测试数据里 11 月排最前）
- `/admin/visitors?range=today|7d|30d|all`：today 只含今天；all 总数不变
- `/`：右栏跟随页面滚动，无独立滚动条
- 系统设置里打开「减少动态效果」后刷新 `/`：卡片不再有进场动画

---

## 6. 阶段 B：全局布局与导航重构

### B.1 阶段目标

把 7 处重复骨架收敛为 1 个组件、5 处宽度公式收敛为 1 个变量、2 份导航数组收敛为 1 份。完成后新增一个页面只需要写 `<SiteShell>`，不需要理解 `max-width` 公式。

> **本阶段会新增 5 个文件**：`components/SiteShell.tsx`、`lib/nav.ts`、`components/rightbar/Blocks.tsx`、`components/rightbar/StatsBlock.tsx`、`components/rightbar/TagCloudBlock.tsx`。其余全是改现有文件。新增前请确认它们在仓库中确实不存在（已核对：均不存在）。

### B.2 任务

---

#### B-1 新增 `SiteShell` 组件并接管 7 处骨架（P1）

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `components/SiteShell.tsx`（**新增**）、`app/page.tsx`、`app/archives/page.tsx`、`app/shuoshuo/page.tsx`、`app/search/page.tsx`、`app/tags/[tag]/page.tsx`、`components/ArticleView.tsx`、`app/friend-links/page.tsx` |
| **当前问题** | 7 个位置各自拼 `site-shell` + `Sidebar` + `main.content` + 可选 `toc-col`；搜索页写了三列网格却没写第三列（右侧空 320px） |
| **计划修改** | 新增 `components/SiteShell.tsx`（见下方「B-1 实现细节」），7 处骨架改为调用它：首页/归档/说说/标签/文章用 `variant="three-col"`（文章传 `toc={toc}`），搜索与友链用 `variant="wide"` |
| **预期效果** | 「有没有右栏」由 `variant` 决定，结构错配不可能再发生；搜索页第三列空白消失 |
| **潜在影响** | `ArticleView` 是唯一传 `toc` 的调用点，`RightBar` 的 `toc` prop 保持原样；友链页 `<main>` 仍需 `fr-main` 类（`friends.css:36-39` 依赖它做 `max-width:960`，阶段 B-4 会改成 `--w-read`） |
| **风险等级** | 中（触及 7 处骨架、7 个文件） |
| **验收标准** | ① `tests/friend-links-page.mjs:132` 的 `class="site-shell"` 断言需要放宽为 `/class="site-shell[ "]/`（因为多了 `site-shell--wide`）——**这是允许的测试修改，必须在 PR 里说明理由**；② 新增断言：`/search` 的 HTML 不含 `class="toc-col"` 且 `.content` 宽度 > 700（1440 视口）；③ 6 个页面 200 且主内容文本与改前一致（可用 `fetchText` 对比关键标题） |
| **依赖** | 依赖 B-2（先有 `--w-shell` 与两个 variant 的 CSS，组件才有意义） |

---

**B-1 实现细节**

```tsx
// components/SiteShell.tsx  —— 服务端组件，无 "use client"
type Variant = "three-col" | "wide";
type Toc = { level: number; text: string; id: string }[];
export function SiteShell({ variant = "three-col", toc, className, children }: {
  variant?: Variant; toc?: Toc; className?: string; children: React.ReactNode;
}) {
  return (
    <div className={`site-shell site-shell--${variant}`}>
      <Sidebar />
      <main className={`content${className ? " " + className : ""}`}>{children}</main>
      {variant === "three-col" ? <div className="toc-col"><RightBar toc={toc} /></div> : null}
    </div>
  );
}
```

各页改为：首页/归档/说说/标签/文章 → `variant="three-col"`（文章传 `toc={toc}`）；搜索 → `variant="wide"`；友链 → `variant="wide" className="fr-main"`。

#### B-2 引入 `--w-shell` / `--w-read`，收敛 5 处宽度公式（P1）

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `app/globals.css`（30-35 令牌、178-196 骨架、765-772 断点、1604-1612 页脚）、`app/friend-links/friends.css`（19-39 骨架覆盖、773-787 断点与 padding 覆盖） |
| **当前问题** | `calc(var(--w-side) + …)` 公式在 5 处各写一遍（`globals:183`、`globals:768`、`globals:1609`、`friends:33`、`friends:776`），其中 `globals:183` 与 `:1609` 完全相同；`friends` 用的是 `960px` 硬编码而不是 `--w-main` |
| **计划修改** | 1) 新增 `--w-read: 960px`、`--w-shell: calc(...)`、`--sticky-top: 40px`；2) `.site-shell{max-width:var(--w-shell)}`、`.site-footer-inner{max-width:var(--w-shell)}`；3) `.site-shell--three-col{grid-template-columns:var(--w-side) minmax(0,var(--w-main)) var(--w-toc)}`；4) `.site-shell--wide{grid-template-columns:var(--w-side) minmax(0,1fr)}` + `.site-shell--wide .content{max-width:var(--w-read)}`；5) 删除 `friends.css` 的两处 `max-width` 覆盖 |
| **预期效果** | 改容器宽度只需改 `--w-shell` 一处；友链页不再重算公式 |
| **潜在影响** | 所有页面宽度来源变化，必须逐视口核对（见第 10 节矩阵） |
| **风险等级** | 中 |
| **验收标准** | `grep -c "calc(var(--w-side)" app/globals.css app/friend-links/friends.css` → globals 只剩 1 处（`--w-shell` 自身）或 0 处（若用变量嵌套），friends 0 处 |
| **依赖** | 无（B-1 依赖它） |

---

#### B-3 断点重构：三栏阈值 1200 → 1392（P1）

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `app/globals.css`（764-800、1089-1122、1191-1254） |
| **当前问题** | 1200→1201 内容宽从 760 骤降到 449（实测）；821–1200 靠 `.side-sheet-entry`（`Sidebar.tsx:49`）补一个抽屉入口填"平板空洞" |
| **计划修改** | 1) `@media (max-width:1200px)` 改为 `@media (max-width:1391px)`，只保留 `grid-template-columns:var(--w-side) minmax(0,1fr)` + `.toc-col{display:none}`；2) `@media (max-width:820px)` 保持单栏；3) `.side-sheet-entry` 的显隐区间跟着从 `821–1200` 改为 `821–1391`（`@media (min-width:1201px)` → `1392px`）；4) 删除 `.toc-col{display:none !important}`（`globals:789`），只保留 `display:none`（`!important` 是因为旧特异性冲突，B-7 会彻底解决） |
| **预期效果** | 1200 附近断崖消失；平板区间变宽但交互不变（仍是左栏 + 抽屉入口） |
| **潜在影响** | 1201–1391 的用户会从「三栏」变为「两栏」，右侧统计/友链/标签云需要点「侧栏」按钮才能看到。这是**行为变化**，需要你确认（Q2） |
| **风险等级** | 中 |
| **验收标准** | ① **10 视口矩阵**（第 10 节 V1–V10，含新增的 1392/1391）全部无横向溢出。<br>② **断点内连续性**（本任务的真正目标）：`1202 / 1201 / 1200 / 1199` 四档同属两栏区，公式 `min(--w-main, vw-392)`，实测算得 `800 / 800 / 800 / 800`——**相邻差 ≤ 1px**；`1200 → 1100` 为 `800 → 708`（差 92px，视口差 100px 减边界取整），属**正常线性收缩，不是断崖**。<br>③ **断点切换点唯一**：`1393 → 1392 → 1391` 为 `641 → 640 → 800`，跳变只发生在 1392/1391 之间；`1391 → 1390` 为 `800 → 800`。该 160px 跳变是「右栏让位」的有意设计，断言里显式登记为预期值。<br>④ **单栏边界**：`821 → 820` 为 `429 → 780`（差 351px），是「三栏收窄 → 单栏铺满」的断点切换，同样登记为预期；`820 → 375` 区间内每档差值 = 视口差（线性）。<br>⑤ `.sidebar.left` 在 `821–1552` 区间恒为 32px（容差 1px）。<br>⑥ **不得为通过断言而修改 `--w-main / --w-toc / --w-side / --gap-col / 1392` 任一参数**；若实测与第 10.3 节表格不符，先查实现（`padding-inline`、`max-width` 上限），确认实现无误后再回头改文档并说明理由。 |
| **依赖** | 依赖 B-2 |

---

#### B-4 友链页去掉布局覆盖（P1）

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `app/friend-links/page.tsx`（128-337）、`app/friend-links/friends.css`（19-39 网格覆盖、773-780 断点覆盖、782-787 padding 覆盖） |
| **当前问题** | `.site-shell.fr-shell` 覆盖 `grid-template-columns` 与 `max-width`，与全局公式不同 → 1440px 下左栏在 76px（首页 32px），偏移 44px；`≤1200` 又重复一遍公式；移动端 padding 用 `8px 20px` 而全局是 `14px 20px` |
| **计划修改** | 1) 页面改用 `<SiteShell variant="wide" className="fr-main">`（B-1）；2) `friends.css` 删除 `.site-shell.fr-shell` 的三处规则（19-39 的网格/max-width、773-780 的 1200 覆盖、782-787 的 padding 覆盖），只保留 `.content.fr-main{max-width:var(--w-read)}`；3) `.fr-grid` 的 `auto-fill minmax(248px,1fr)` 保留（它本来就自适应） |
| **预期效果** | 1440/1200 下友链页左栏与首页完全对齐（都是 32px） |
| **潜在影响** | 友链页正文宽度从"固定 960"变成"两栏宽版 960（上限）"，在 1100px 视口下会从 960 收到 708 —— **更窄**。需求文档说"主内容可以适当扩展"，但没说必须永远 960。若你要求友链页永远比别页宽，需要单独给 `--w-read-friends`（Q1） |
| **风险等级** | 中 |
| **验收标准** | 浏览器断言：1440/1200/1100/900/821 五档，`/friend-links` 与 `/` 的 `.sidebar` `getBoundingClientRect().left` 差值 ≤ 1px |
| **依赖** | 依赖 B-1、B-2 |

---

#### B-5 友链页双 Footer（P1）

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `app/friend-links/page.tsx`（332-335）、`components/SiteFooter.tsx`、`app/layout.tsx`（84） |
| **当前问题** | 友链页有自己的 `<footer className="fr-footer">`（"感谢每一位愿意分享自己小世界的人"），同时 `app/layout.tsx:84` 又渲染全站 `SiteFooter`（备案号 + footerText）。实测两页脚同时存在 |
| **计划修改** | **保留 `fr-footer` 作为页面内语义收尾，把它从 footer 改为普通 section**（`<div className="fr-footer">`），避免一个页面两个 `<footer>` 地标（a11y 问题）。全站页脚继续由 layout 提供 |
| **预期效果** | 页面结构上只有一个 `<footer>`；视觉上两段文字都保留（需求文档没有要求删掉那句文案） |
| **潜在影响** | 极低。若你要的是"只保留一个"，则改为直接删 `fr-footer`（Q4） |
| **风险等级** | 低 |
| **验收标准** | `tests/friend-links-page.mjs` 新增断言：页面 HTML 中 `<footer` 出现次数 = 1 |
| **依赖** | 无 |

---

#### B-6 搜索页三列空白 + 移动端搜索框消失（P1）

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `app/search/page.tsx`（27-45、89）、`app/globals.css`（1281-1296）、`components/SearchBox.tsx` |
| **当前问题** | ① 页面用 `site-shell`（三列）但没有 `toc-col` 子元素 → 1440px 下右侧空 320px；② 页面手写了第二份搜索表单（`search/page.tsx:31-45`），类名 `content-search` 正好命中 `globals.css:1294` 的 `@media (max-width:820px){.content-search{display:none}}` → 移动端该页**没有任何输入框**（实测 `formDisplay:none`、高度 0） |
| **计划修改** | 1) 改用 `<SiteShell variant="wide">`；2) 表单换成 `<SearchBox initial={q} variant="dashed" />`（`SearchBox` 已支持 `initial`），并把外层类名从 `content-search` 改为 `search-page-form`；3) 新增 `.search-page-form{margin-bottom:24px}`，`≤820px` 不再隐藏它；4) 首页那处 `content-search` 保留隐藏规则（首页确实有顶栏搜索兜底） |
| **预期效果** | 搜索页三列空白消失；移动端搜索页有可用输入框 |
| **潜在影响** | `SearchBox` 是客户端组件（`useState` + `router.push`），搜索页会因此带上它——可接受（首页已经在用） |
| **风险等级** | 低 |
| **验收标准** | 浏览器：375×812 打开 `/search`，断言输入框 `offsetHeight > 0`、`document.activeElement` 可聚焦、提交后 URL 变为 `/search?q=…` |
| **依赖** | 依赖 B-1 |

---

#### B-7 导航单源 + `active` 自判（P1）

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `lib/nav.ts`（**新增**）、`components/Sidebar.tsx`、`components/MobileNav.tsx`、`app/globals.css`（204-212、1046-1088） |
| **当前问题** | ① 两份 `NAV` 数组，标签/顺序/图标都不同（`Sidebar.tsx:5-11` vs `MobileNav.tsx:9-15`）；② `active` 是手工字符串，`/about` 传 `""`（`ArticleView.tsx:71`）、`/tags/*` 传 `""`、`/search` 传 `"/search"`（不在数组里）→ 三个页面无选中态；③ `.nav a`（特异性 0,1,1，`globals:204-212`）压过 `.nav-item`（0,1,0，`globals:1048`）→ 实测新导航样式从未生效（padding `6px 10px` 而不是 `13px 16px`，radius `8px` 而不是 `13px`） |
| **计划修改** | 1) 新增 `lib/nav.ts`（见 TD-5）；2) `Sidebar` 加 `"use client"`，删 `active` prop，用 `usePathname()` + `activeHref()`；3) `MobileNav` 删本地 `NAV`，改用 `NAV_ITEMS` + `activeHref`；4) **删除 `globals.css:204-212` 的 `.nav a / .nav a:hover / .nav a.active` 三条规则**（只保留 `.nav` 容器那条），让 `.nav-item` 生效；5) 同步改暗色字重补偿里的 `.nav a.active` 选择器（`globals:1838`、`1856`）为 `.nav-item.is-active` |
| **预期效果** | 导航项恢复 `.nav-item` 的设计值（`padding:13px 16px`、`border-radius:13px`、`font-size:.95rem`），而不是被 `.nav a` 压成的 `6px 10px` / `8px` / `.925rem`；`/about`、`/tags/*` 正确高亮；移动端与桌面端标签一致 |
| **潜在影响** | **导航视觉会变**（这正是修复，但属于"阶段 B 里唯一可见的视觉变化"）。暗色字重补偿若漏改会让暗色下导航字重跳变 |
| **风险等级** | 中 |
| **验收标准** | ① 单测新增：`activeHref("/p/123") === "/"`、`activeHref("/tags/ai") === "/"`、`activeHref("/search") === null`、`activeHref("/about") === "/about"`；② 浏览器：1440 下 `.nav-item` 的 `padding` = `13px 16px`、`border-radius` = `13px`；③ `/about` 页 `.nav-item.is-active` 数量 = 1 |
| **依赖** | 无（可与 B-1 并行，但两者都改 `Sidebar` 的调用点，建议 B-7 先落，B-1 再改） |

---

#### B-8 右栏内容单源（桌面/移动共用区块）（P1）

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `components/RightBar.tsx`、`components/MobileSidebar.tsx`、`components/FriendLinks.tsx`、`components/rightbar/StatsBlock.tsx`（**新增**）、`components/rightbar/TagCloudBlock.tsx`（**新增**）、`components/rightbar/Blocks.tsx`（**新增**，含 `SidebarBlock` 壳） |
| **当前问题** | 统计块（`RightBar.tsx:31-44` vs `MobileSidebar.tsx:28-41`）、聚合/友链（`FriendLinks.tsx:14-50` vs `MobileSidebar.tsx:44-85`，连 `🚇`/`🔗`/`↗` 都一模一样）、标签云（`RightBar.tsx:51-71` vs `MobileSidebar.tsx:88-108`）各写两遍。`rb-block` 结构在项目里出现 9 次 |
| **计划修改** | 抽 4 个**纯展示**组件（都接收数据，不自己查库）：`<SidebarBlock title count>{children}</SidebarBlock>`、`<StatsBlock stats />`、`<TagCloudBlock tags />`、`<FriendLinkBlocks links />`（把 `FriendLinks.tsx` 的 `HubCard`/`LinkRow` 提出来共用）。`RightBar` 与 `MobileSidebarContent` 都只负责取数 + 组合 |
| **预期效果** | 区块结构单源；以后改统计块样式只改一处 |
| **潜在影响** | `MobileSidebar` 的 DOM 结构会变（多一层 section 包裹），若有测试依赖其结构需同步（目前没有） |
| **风险等级** | 低 |
| **验收标准** | `rb-block` 的出现位置从 9 处降到 4 处（`SidebarBlock` 壳 1 处 + `FriendLinks` 2 处 + `RightBar` 的目录块 1 处）；浏览器：`/` 与 375px 抽屉里 `.stat-cell` 数量相等，桌面与抽屉的友链条目名集合相等 |
| **依赖** | 依赖 B-1（先有统一骨架，再改内部） |

### B.3 文件修改清单（阶段 B）

| 文件 | 动作 | 任务 |
| --- | --- | --- |
| `components/SiteShell.tsx` | **新增** | B-1 |
| `lib/nav.ts` | **新增** | B-7 |
| `components/rightbar/Blocks.tsx` | **新增** | B-8 |
| `components/rightbar/StatsBlock.tsx` | **新增** | B-8 |
| `components/rightbar/TagCloudBlock.tsx` | **新增** | B-8 |
| `app/page.tsx` | 改骨架 | B-1 |
| `app/archives/page.tsx` | 改骨架 | B-1 |
| `app/shuoshuo/page.tsx` | 改骨架 | B-1 |
| `app/search/page.tsx` | 改骨架 + 换 `SearchBox` | B-1 / B-6 |
| `app/tags/[tag]/page.tsx` | 改骨架 | B-1 |
| `components/ArticleView.tsx` | 改骨架 + 传 `toc` | B-1 |
| `app/friend-links/page.tsx` | 改骨架 + `fr-footer`→`div` | B-1 / B-4 / B-5 |
| `app/friend-links/friends.css` | 删 3 处布局覆盖 | B-4 |
| `app/globals.css` | 令牌、断点、删 `.nav a*` | B-2 / B-3 / B-7 |
| `components/Sidebar.tsx` | 加 `"use client"`、删 `active` | B-7 |
| `components/MobileNav.tsx` | 用 `NAV_ITEMS` | B-7 |
| `components/RightBar.tsx` | 用新区块组件 | B-8 |
| `components/MobileSidebar.tsx` | 用新区块组件 | B-8 |
| `components/FriendLinks.tsx` | 导出 `HubCard`/`LinkRow` 供复用 | B-8 |
| `tests/friend-links-page.mjs` | 改：`site-shell` 断言放宽；新增 `<footer` 计数 | B-1 / B-5 |
| `tests/layout-regression.mjs` | **新增**：10 视口布局断言（含 1392/1391 断点对） | B-2/B-3/B-4 |

### B.4 执行顺序与依赖

```
B-2 ──► B-1 ──► B-4 ──► B-8
          │       ▲
          ├──► B-6
          └──► B-5
B-3 ── 依赖 B-2，可与 B-1 并行
B-7 ── 独立（先做，因为它改 Sidebar，B-1 会用到新签名）
```

推荐实际顺序：**B-7 → B-2 → B-3 → B-1 → B-4 → B-5 → B-6 → B-8**。
理由：B-7 改 `Sidebar` 的 prop 签名，越早做后面越省事；B-2/B-3 是纯 CSS 可单独验收；B-1 是结构改造，放在 CSS 稳定后。

### B.5 阶段 B 回归测试

```bash
npm test && npx tsc --noEmit && npm run build
npm run test:next            # 页面 200 / 搜索 / 308 / 缓存
npm run test:friends         # 友链页（含边界态）
npm run test:dark            # 暗色（B-7 改了字重补偿选择器）
node tests/layout-regression.mjs   # 新增：10 视口（含 1392/1391）
```

**人工检查**：见第 10 节矩阵（10 视口 × 9 检查项）。

---

## 7. 阶段 C：CSS 设计系统与组件治理

### C.1 阶段目标

让「改一个颜色/圆角」不需要全文搜索；让「暗色」只维护一份；让「主题切换」在两个实例间同步。完成后 `globals.css` 行数应下降（删死代码）而不是上升。

### C.2 任务

---

#### C-1 删除 58 个未使用 token（P2）

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `app/globals.css`（1883-1979）、`tests/design-tokens.test.ts` |
| **当前问题** | 58 个 token（`--space-*`/`--radius-*`/`--fs-*`/`--lh-*`/`--fw-*`/`--btn-*`/`--field-*`/`--table-*`/`--skeleton-*`/`--toast-*`），`var()` 引用 0 处，名字在全项目其它位置也搜不到 |
| **计划修改** | 整体删除该 `:root{}` 块（保留 1981-1990 的 `@keyframes ui-spin` / `ui-pulse`，它们**有**引用：`components/ui/Button.tsx:88`）。然后把 TD-7 列的 12 个真需要的 token 加到主 `:root` |
| **预期效果** | `globals.css` 少 97 行；不再有"看起来已抽象"的假象 |
| **潜在影响** | 若某处通过字符串拼接引用（`var("--space-" + n)`）会断。已核对：无此类写法 |
| **风险等级** | 低 |
| **验收标准** | `tests/design-tokens.test.ts` 增加反向断言：`definedTokens` 里每个 token 必须在 `var()` 中被引用（白名单：主题令牌 `--bg/--text-*/--border*/--cat-*/--font-*/--fw-body/--tap*/--safe-*`，它们由设计意图保留） |
| **依赖** | 无（但建议在 B-2 之后做，避免与新增 token 冲突） |

---

#### C-2 合并暗色令牌与字重补偿的重复块（P1）

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `app/globals.css`（68-102、104-139、1831-1864） |
| **当前问题** | ① 两套暗色令牌各 47 个，逐 token diff **完全一致**（实测 diff = 0）；② 字重补偿在 `:root[data-theme="dark"]` 与 `@media (prefers-color-scheme: dark)` 里各写一遍（21 条规则，`1831-1846` 与 `1849-1864`）；③ 改一个暗色值要同时改两处，漏一处就出现「手动暗色」与「系统暗色」不一致 |
| **计划修改** | 把 47 个暗色**值**抽成一组 `--dark-*` 变量（只写一份），两个暗色作用域只做赋值。详见下方「C-2 实现细节」 |
| **预期效果** | 47 个暗色字面量只出现一次；改色只需改 `--dark-*`；两块映射机械且可 diff |
| **潜在影响** | 多一层变量间接；`var()` 解析成本可忽略（CSS 变量在计算期展开） |
| **风险等级** | 中（暗色是全局的，错了很难一眼看出） |
| **验收标准** | ① `npm run test:dark` 绿；② `grep -c "#141414" app/globals.css` 从 2 降到 1（只剩 `--dark-bg` 定义处）；③ 4 个页面 × 明暗截图改前改后逐像素一致（纯重构，不改值） |
| **依赖** | 依赖 C-1（token 清理完再动结构） |

**C-2 实现细节**

先说清楚**做不到**的事：暗色令牌不能真的合并成一条规则。因为"跟随系统"那一套必须包在 `@media (prefers-color-scheme: dark)` 里，而媒体查询是外层条件，结构上必须独立成块：

```css
/* 这两块无法合成一块 —— 一个是选择器条件，一个是媒体条件 */
:root[data-theme="dark"] { /* 47 个值 */ }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]):not([data-theme="dark"]) { /* 同样的 47 个值 */ }
}
```

但**值**可以只写一份，两处只做转赋值：

```css
/* ① 值只在这里出现一次 */
:root {
  --dark-bg: #141414;
  --dark-bg-subtle: #1a1a1a;
  /* …共 47 个 --dark-* … */
}

/* ② 手动暗色：只做映射 */
:root[data-theme="dark"] {
  --bg: var(--dark-bg);
  --bg-subtle: var(--dark-bg-subtle);
  /* …共 47 行，无字面量… */
}

/* ③ 系统暗色：同样的映射 */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]):not([data-theme="dark"]) {
    --bg: var(--dark-bg);
    /* … */
  }
}
```

代价：多一层变量间接（`--bg → --dark-bg → #141414`）。CSS 变量在计算期展开，运行时成本可忽略；但**调试时 DevTools 会多显示一层**，需要在 `--dark-*` 上加注释说明。

**字重补偿不做**。那 21 条规则重复的只是"选择器 + 数字"，抽成 `--fw-comp-1: 510` 再层层转赋值，可读性损失大于收益。这条任务**只处理令牌**。

**验收的关键**：这是纯重构，**改完前后暗色截图必须逐像素一致**。如果不一致，说明某处 `--dark-*` 抄错了值——这正是这一步的价值（把"两份可能漂移的值"变成"一份值 + 两条机械映射"）。

---

#### C-3 `color-scheme` 支持（P1）

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `app/globals.css`（`:root` 与两个暗色块） |
| **当前问题** | 三个样式表里 `color-scheme` 出现 0 次 → 暗色下原生滚动条、`<select>`、`<input type="date">`、自动填充底色仍是亮色 |
| **计划修改** | `:root{color-scheme:light}`、`:root[data-theme="dark"]{color-scheme:dark}`、`@media(prefers-color-scheme:dark){:root:not([data-theme="light"]):not([data-theme="dark"]){color-scheme:dark}}` |
| **预期效果** | 原生控件跟随主题 |
| **潜在影响** | 表单控件默认外观变化（后台也受影响，是改进） |
| **风险等级** | 低 |
| **验收标准** | 浏览器：暗色下 `getComputedStyle(document.documentElement).colorScheme === "dark"`；截图对比滚动条颜色 |
| **依赖** | 无 |

---

#### C-4 `ThemeToggle` 多实例同步（P1）

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `components/ThemeToggle.tsx`、`tests/dark-mode.mjs` |
| **当前问题** | 2 个前台实例 + 2 个后台实例各自持有 `theme` state；实测点一次后另一个实例 `aria-label` 仍是旧值（读屏错误） |
| **计划修改** | `ThemeToggle` 用 `useSyncExternalStore` 订阅 `documentElement` 的 `data-theme`，不再自持 state；同时把两处主题色硬编码收进 `lib/theme-colors.ts`。详见下方「C-4 实现细节」 |
| **预期效果** | 任一实例切换，全部实例的图标与 `aria-label` 同步 |
| **潜在影响** | `ThemeScript`（首屏内联脚本）必须在 CSS 变量可用**之前**设置 `theme-color`，所以它仍需要硬编码兜底 —— 保留但也收进一个常量文件 `lib/theme-colors.ts` |
| **风险等级** | 中（首屏防闪烁逻辑很容易改坏） |
| **验收标准** | 浏览器：1440 下点桌面侧栏的切换 → 断言移动顶栏那个切换按钮的 `aria-label` 同步变化；**再断言首屏无 FOUC**：暗色偏好下 `document.documentElement.dataset.theme` 在 `DOMContentLoaded` 前就是 `dark` |
| **依赖** | 无 |

---

**C-4 实现细节**

```tsx
const theme = useSyncExternalStore(subscribeTheme, readTheme, () => null);
// subscribeTheme: MutationObserver on documentElement attributes
// readTheme: () => document.documentElement.getAttribute("data-theme")
```

`toggle()` 仍写 `data-theme` + `localStorage`，其它实例通过 observer 自动同步。
**同时**把 `#141414`/`#fffefc` 两处硬编码改为从 `--bg` 计算（`getComputedStyle(document.documentElement).getPropertyValue("--bg")`），让 `app/layout.tsx:55`、`app/manifest.ts:12-13`、`ThemeScript.tsx:21` 三处不再各写一份色值。

#### C-5 前台 13 处内联样式改语义类（P2）

> 口径：13 = `app/`（非 `app/admin/`）+ `components/`（非 `components/admin/`、非 `components/ui/`）里的 `style={{` 计数。后台 28 处（`app/admin` 16 + `components/admin` 12）与 `components/ui` 7 处**不在本次范围**。

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `app/archives/page.tsx`（3 处）、`app/not-found.tsx`（3 处）、`app/page.tsx`（1 处）、`app/search/page.tsx`（1 处）、`app/tags/[tag]/page.tsx`（1 处）、`components/ArticleView.tsx`（2 处：分类色 + 封面图）、`components/PostCard.tsx`（1 处：分类色）、`components/CommentSection.tsx`（1 处：错误提示）|
| **当前问题** | 前台 13 处 `style={{…}}`；其中归档页 3 处写死了 `fontSize:.78rem / color:var(--text-p4)` 等，改版时无法统一调 |
| **计划修改** | 归档：`.archive-year-count` / `.archive-month` / `.archive-month-group`；404：`.notfound` / `.notfound-code` / `.notfound-text`；分页当前页：`.pager-current`（替代 `pointerEvents:none`）；搜索命中数：`.search-meta`；标签页：`.tag-count`；文章封面：`.article-cover`；评论错误：`.comment-error`。<br>**只有分类色（`categoryColor()` 返回的 `fg`/`bg`）保留内联**——它是运行时数据驱动的，改成 class 要动态生成 CSS（Q5） |
| **预期效果** | 前台内联样式从 13 → 2（只剩 `ArticleView` 与 `PostCard` 的分类色） |
| **潜在影响** | 归档页视觉可能有 1px 级差异，需截图对比 |
| **风险等级** | 低 |
| **验收标准** | 前台 `style={{` 计数降到 2（只剩 `categoryColor()` 的数据驱动色）；`/archives` 截图与改前 diff = 0（容差 1px） |
| **依赖** | 无 |

---

#### C-6 清理重复选择器与死 CSS（P2）

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `app/globals.css` |
| **当前问题** | `.article-title` 定义 5 次（310 / 343 组 / 792 / 1141 / 1844+1862）；移动端 `792` 的 `font-size:1.5rem` 被后面 `1141` 的 `2.05rem` 覆盖 → 实测 375px 下标题仍是 **32.8px**（应为 24px）；`.nav` 定义 2 次（198 / 1047）；`:root` 定义 3 次（4 / 857 / 1900）；`.toc-col` 的 `display:none` 出现 2 次（770 / 789，后者带 `!important`）；`.mobile-topbar` 基础定义在 175 与 802 两处 |
| **计划修改** | 1) `.article-title` 只保留 `1141` 那一处，移动端覆盖（792）**移到文件末尾的 `≤820` 媒体查询块里**并确认特异性足够（同一选择器后出现即可）；2) 删除 310 那处（被 1141 完全覆盖，字段一一对应）；3) 合并 `:root` 的三处（857 是动效令牌，1900 将被 C-1 删掉）；4) 删 `.toc-col{display:none!important}`；5) 死类清单：先按脚本粗扫（18–31 个），**再逐个 grep 动态拼接**（`is-active`/`active`/`in`/`lv3`/`badge-*` 是三元拼的，不能删），确认无引用后删除 `.sidebar-footer`、`.toc-title`、`.only-mobile`、`.mobile-drawer-search`、`.empty`、`.comment`、`.comment-avatar/-body/-head/-date/-text`、`.icon-inline`、`.video-container` |
| **预期效果** | 移动端文章标题真的变小；`.article-title` 一处定义 |
| **潜在影响** | 移动端文章页观感变化（标题 32.8→24px）。这是**可见变化**，需你确认（Q6） |
| **风险等级** | 中 |
| **验收标准** | 浏览器：375×812 下 `.article-title` 的 `fontSize` = `24px`（1.5rem@16px）；1440 下 = `32.8px`；`grep -c "\.article-title"` 从 5 → 2（一处定义 + 一处移动覆盖） |
| **依赖** | 无 |

---

#### C-7 设计令牌刻度补齐（P2）

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `app/globals.css`（`:root`） |
| **当前问题** | 字面量散落：`border-radius:10px` ×14、`8px` ×6、`12px` ×3；`font-size:.78rem` ×8、`.82rem` ×8；`gap:8px` ×9；`transition` 31 处、时长 8 档（`.15/.16/.18/.2/.24/.25/.3/.5`）；`z-index` 4 档（1/50/100/200，抽屉与对话框同层）；`44px` ×14、`48px` ×6（已有 `--tap`/`--tap-lg` 却没用） |
| **计划修改** | 新增 C-1 保留的 12 个 token；然后**只在本阶段改动的规则里使用**，不做全量替换（全量替换 1990 行 CSS 回归面太大） |
| **预期效果** | 新代码有刻度可用；老代码保持不动 |
| **潜在影响** | 无（纯新增） |
| **风险等级** | 低 |
| **验收标准** | `tests/design-tokens.test.ts` 绿；新增 token 在两个暗色块里都有定义（暗色无关的尺寸类可只在 `:root`） |
| **依赖** | 依赖 C-1 |

---

#### C-8 抽 `PageHeader` / `EmptyState`（P2）

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `components/PageHeader.tsx`（**新增**）、`components/EmptyState.tsx`（**新增**）、`app/archives/page.tsx`、`app/shuoshuo/page.tsx`、`app/search/page.tsx`、`app/tags/[tag]/page.tsx`、`app/page.tsx` |
| **当前问题** | `<h1 className="page-title">` 在 4 个页面各写一次，副标题又各写内联；`.empty-block` 结构在 5 个前台位置重复（首页 31-41、归档 26-32、说说 22-30、搜索 58-66/83-86），只有文案不同 |
| **计划修改** | `<PageHeader title="归档" sub="共 32 篇" />`（`sub` 可选，渲染为 `.page-sub`）；`<EmptyState title hint actions />`（`actions` 是 ReactNode，复用现有 `.empty-block` 类，**不改类名语义**） |
| **预期效果** | 5 处空状态结构 → 1 处；页面标题结构统一 |
| **潜在影响** | `components/admin/ui.tsx:89` 也有一个 `Empty` 组件，用的**同一套 `.empty-block` 类**。所以：`EmptyState` 只是把前台 5 处 JSX 收成一个组件，**不新增也不改任何 CSS**，后台零影响。反过来说，若将来要改 `.empty-block` 的样式，前台和后台会一起变——这条要写进红线 |
| **风险等级** | 低 |
| **验收标准** | 前台 TSX 里 `className="empty-block"` 从 5 处降到 1 处（在 `EmptyState` 内），`app/admin`+`components/admin` 仍为 1 处（未受影响）；4 个页面标题的 DOM 结构一致 |
| **依赖** | 无 |

---

#### C-9 品牌信息与主题色去硬编码（P2）

| 项 | 内容 |
| --- | --- |
| **涉及文件** | `components/Sidebar.tsx`（20-22）、`components/MobileNav.tsx`（91）、`app/layout.tsx`（55）、`app/manifest.ts`（5-13）、`components/ThemeScript.tsx`（21）、`components/ThemeToggle.tsx`（31）、`lib/theme-colors.ts`（**新增**） |
| **当前问题** | 站名 `flechazo` 与简介 `记录 AI、开发与折腾的日常` 在 2 处硬编码，而 `settings` 表里已经有 `siteTitle`/`siteDescription`/`author`；主题色 `#fffefc`/`#141414` 在 4 处重复 |
| **计划修改** | 1) `Sidebar` 接收 `siteName`/`siteDesc`/`avatar` props（由 `SiteShell` 从 `getSettings()` 取并传入）；2) `MobileNav` 同理；3) 新建 `lib/theme-colors.ts` 导出 `LIGHT_BG = "#fffefc"`、`DARK_BG = "#141414"`，四处引用它。`manifest.ts` 是静态路由，只能保留常量（可接受） |
| **预期效果** | 后台改站名 → 前台侧栏与移动顶栏同步变化 |
| **潜在影响** | `Sidebar` 变成"接收 props 的客户端组件"，`getSettings()` 的调用从每个页面移到 `SiteShell`（一次） |
| **风险等级** | 低 |
| **验收标准** | 后台改 `siteTitle` → 前台侧栏文字变化（集成测试可用 `settings` API 改后 `waitForFresh` 断言） |
| **依赖** | 依赖 B-1（`SiteShell` 是取 settings 的地方） |

### C.3 文件修改清单（阶段 C）

| 文件 | 动作 | 任务 |
| --- | --- | --- |
| `app/globals.css` | 删死 token、合并暗色、`color-scheme`、删重复选择器、补刻度 | C-1/C-2/C-3/C-6/C-7 |
| `components/ThemeToggle.tsx` | 改 `useSyncExternalStore` | C-4 |
| `lib/theme-colors.ts` | **新增** | C-4 / C-9 |
| `components/PageHeader.tsx` | **新增** | C-8 |
| `components/EmptyState.tsx` | **新增** | C-8 |
| `app/archives/page.tsx` | 内联样式 → 类；用 `PageHeader`/`EmptyState` | C-5 / C-8 |
| `app/not-found.tsx` | 内联样式 → 类 | C-5 |
| `app/page.tsx` | 分页当前页类名；`EmptyState` | C-5 / C-8 |
| `app/search/page.tsx` | `search-meta`；`EmptyState` | C-5 / C-8 |
| `app/tags/[tag]/page.tsx` | `tag-count`；`PageHeader` | C-5 / C-8 |
| `app/shuoshuo/page.tsx` | `PageHeader`/`EmptyState` | C-8 |
| `components/Sidebar.tsx` | 接收品牌 props | C-9 |
| `components/MobileNav.tsx` | 接收品牌 props | C-9 |
| `app/layout.tsx` | theme-color 用常量 | C-9 |
| `app/manifest.ts` | 用常量 | C-9 |
| `components/ThemeScript.tsx` | 用常量 | C-9 |
| `tests/design-tokens.test.ts` | 加反向断言 | C-1 |
| `tests/css-health.test.ts` | 加重复选择器/内联样式断言 | C-6 |

### C.4 执行顺序与依赖

```
C-1 ──► C-7
C-2 ── 依赖 C-1
C-3 ── 独立
C-4 ── 独立（但 C-9 依赖它的常量文件）
C-5 ── 独立
C-6 ── 独立（但建议在 C-1/C-2 之后，避免行号冲突）
C-8 ── 独立
C-9 ── 依赖 B-1 + C-4
```

推荐顺序：**C-3 → C-4 → C-1 → C-2 → C-6 → C-5 → C-8 → C-9 → C-7**。
理由：`color-scheme` 和主题同步风险最低、收益最直接；token 清理要与 C-7 连着做；C-6 的行号调整放在 token 稳定后。

### C.5 阶段 C 回归测试

```bash
npm test && npx tsc --noEmit && npm run build
npm run test:ui        # 后台 UI kit（含对比度 / 44px 热区 / 375 溢出）
npm run test:dark      # 暗色（重点）
npm run test:admin     # 后台导航与概览
npm run test:integration
```

**人工检查**：`/admin` 全页面（阶段 C 动了 `:root` 与 `color-scheme`，后台共享这些令牌）；4 个前台页面 × 明暗 × 桌面/移动 = 16 张截图。

---

## 8. 阶段 D：前台视觉改版

> **编号说明（本章有两套编号，别混）**
> - `D.1 / D.2 / D.3 / D.4` —— **小节号**（带点），指本章的「阶段目标 / 页面顺序 / 验收流程 / 额外约束」。
> - `D-1 … D-5` —— **视觉任务号**（带连字符），指五个页面的改版任务。
> - 第四章的技术决策是 `TD-1 … TD-8`，与本阶段无关。

### D.1 阶段目标

在 A/B/C 提供的稳定地基上，按需求文档逐页实现视觉改版。**这一阶段只改视觉，不改数据流、不改路由、不改接口。**

### D.2 页面顺序与验收

| 任务 | 页面 | 主要文件 | 需求文档对应 | 验收 |
| --- | --- | --- | --- | --- |
| **D-1** | 首页 | `app/page.tsx`、`components/PostCard.tsx`、`app/globals.css`（`.post-card`/`.post-list`/`.meta`） | 第四章 4.1–4.6 | 卡片高度压缩 10–15%；摘要 2 行截断；元信息四项齐；无大 Hero |
| **D-2** | 关于 | `content/pages/about.md`（内容）、`components/ArticleView.tsx`；若需独立版式，可新增 `app/about/page.tsx`（**需你确认，见 Q9**） | 第七章 7.1–7.7 | 顶部个人介绍 + 关注方向 + 保留右栏目录 |
| **D-3** | 友链 | `app/friend-links/page.tsx`、`app/friend-links/friends.css` | 第六章 6.1–6.6 | Hero 高度收紧；卡片桌面两列；统计动态；**不推翻重做** |
| **D-4** | 说说 | `app/shuoshuo/page.tsx`、`app/globals.css`（`.shuo-*`） | 第五章 5.1–5.5 | 轻量时间线；日期格式 `2026年10月29日`；无大卡片 |
| **D-5** | 归档/搜索/标签 | `app/archives/page.tsx`、`app/search/page.tsx`、`app/tags/[tag]/page.tsx` | 第八章 8.3–8.4、第九章 | 归档时间线；搜索空状态；标签页 |

### D.3 每页的固定验收流程

1. 改前：在 10 个视口 × 明暗下各截一张基线图（存 `.tmp-review/D-x-before/`）。
2. 改后：同矩阵再截一组。
3. 逐张对比，记录差异清单（哪些是意图内、哪些是意外）。
4. 跑 `npm run test:integration`。
5. 跑需求文档「第十二节 最终验收标准」逐条勾选。

### D.4 阶段 D 的额外约束

- 不改 `PostCard` 的 props 契约（`href/title/excerpt/date/categories/readingTime/views`）——它被首页、标签、搜索三处复用。
- 友链页的 `FriendCard`/`SiteAvatar`/`CopyFriendConfig`/`JumpToComments` 保持不动，只调 CSS。
- 关于页若需要"关注方向/正在做的事"等结构化区块，内容必须来自 `content/pages/about.md` 或 `settings`，**不允许写死在组件里**（当前 `about.md` 已有「我在做什么」「本站」「联系」三节，D-2 应基于它重组，而不是新造一套文案）。
- 任何新增图片必须有 `width`/`height` 或 `aspect-ratio`，防止 CLS。

---

## 9. 阶段间依赖与并行策略

```
阶段 A（A-1→A-2→A-3 串行；A-4/A-5 并行）
        │  准出：test:integration 绿 + 备份可恢复
        ▼
阶段 B（B-7→B-2→B-3→B-1→B-4→B-5→B-6→B-8）
        │  准出：10 视口矩阵绿 + 截图无非预期变化
        ▼
阶段 C（C-3→C-4→C-1→C-2→C-6→C-5→C-8→C-9→C-7）
        │  准出：test:dark/test:ui/test:admin 绿 + 暗色截图无变化
        ▼
阶段 D（D-1→D-2→D-3→D-4→D-5）
```

**跨阶段可并行的部分**：
- A-4（右栏滚动）与 A-5（reduced-motion）可以在 A-1 之前先做——它们与日期无关，能立刻改善体验。
- B-7（导航）可以在 A 阶段并行准备，但**合入必须在 A 之后**（避免同时改两个地方导致回归定位困难）。
- C-3（`color-scheme`）可以在 B 阶段末尾就开始，它不影响布局。

**绝对不允许并行**：A-1/A-2/A-3 之间；B-2 与 B-3 之间（同一个媒体查询块）；C-1 与 C-7 之间。

---

## 10. 响应式验收矩阵

### 10.1 视口

| # | 设备 | 分辨率 | 关注点 |
| --- | --- | --- | --- |
| V1 | 大屏桌面 | 1440×900 | 三栏齐、右栏 sticky、无嵌套滚动 |
| V2 | 断点边界（三栏最低点） | **1392×900** | `.content` = 640；**三栏存在**；`.toc-col` 可见 |
| V3 | 断点边界（两栏最高点） | **1391×900** | `.content` = 800；**三栏消失**；`.toc-col` 为 `display:none`；`.side-sheet-entry` 可见 |
| V4 | 小屏桌面 | 1201×900 | 两栏；`.content` = 800（原断崖点，现应为 800） |
| V5 | 断点边界 | 1200×900 | 两栏；`.content` = 800；与 V4 差 ≤ 1px |
| V6 | 平板 | 1100×900 | 两栏、左栏 288、无右栏、`.content` = 708 |
| V7 | 小平板 | 900×900 | 两栏、`.content` = 508 |
| V8 | 断点边界（两栏最低点） | 821×900 | 两栏最窄、`.content` = 429、`.side-sheet-entry` 可见 |
| V9 | 手机 | 820×900 | 单栏、左栏隐藏、顶栏出现、`.content` = 780 |
| V10 | 手机 | 375×812 | 单栏、无横向溢出、标题换行、`.content` = 335 |

> **V2/V3 是本轮新增的断点专测对**：它们只差 1px 视口宽，但必须呈现完全不同的模式（三栏 vs 两栏）。其余视口覆盖线性收缩区。
> 旧版矩阵是 8 档且缺少 1392/1391，导致"三栏到底在哪一像素切换"从未被验证过——这正是 B-3 最需要锁住的地方。

### 10.2 检查项（每个视口 × 每个页面）

| # | 检查项 | 自动化方式 |
| --- | --- | --- |
| 1 | 无横向溢出 | `document.documentElement.scrollWidth <= clientWidth + 1` |
| 2 | 左栏正确显示/隐藏 | `≤820` 时 `.sidebar` 的 `display === "none"`，否则 `block` |
| 3 | 主内容宽度符合预期 | 与第 10.3 节表格逐一比对（容差 2px） |
| 4 | 右栏无独立滚动 | 遍历可见元素，`overflow-y:auto\|scroll && scrollHeight>clientHeight+1` 的数量 = 0 |
| 5 | 移动抽屉可开合 | 点 `.mobile-menu-btn` → `.mobile-drawer` 可见；Esc 关闭 |
| 6 | 标题与正文换行 | `.article-title` 的 `scrollWidth <= clientWidth + 1`；长英文串不溢出 |
| 7 | Footer 与内容对齐 | `.site-footer-inner` 的 `left` 与 `.site-shell` 的 `left` 相同 |
| 8 | 明暗切换 | 切 `data-theme` 后 `body` 背景色变化，且无元素回退到硬编码浅色 |
| 9 | 友链页左栏对齐 | `/friend-links` 与 `/` 的 `.sidebar.left` 差 ≤ 1px |

### 10.3 期望值（阶段 B 完成后，计算自本方案）

| 视口 | 标准页模式 | 标准页 `.content` | 宽版页 `.content` | `.sidebar.left` |
| --- | --- | --- | --- | --- |
| 1600 | 三栏 | 800 | 960 | 56（居中） |
| 1552 | 三栏 | 800 | 960 | 32 |
| 1440 | 三栏 | 688 | 960 | 32 |
| **1392** | **三栏** | **640**（三栏最低点） | 960 | 32 |
| **1391** | **两栏** | **800** | 960 | 32 |
| 1202 | 两栏 | 800 | 810 | 32 |
| 1201 | 两栏 | 800 | 809 | 32 |
| 1200 | 两栏 | 800 | 808 | 32 |
| 1199 | 两栏 | 800 | 807 | 32 |
| 1100 | 两栏 | 708 | 708 | 32 |
| 900 | 两栏 | 508 | 508 | 32 |
| 821 | 两栏 | 429 | 429 | 32 |
| 820 | 单栏 | 780 | 780 | —（左栏隐藏） |
| 375 | 单栏 | 335 | 335 | —（左栏隐藏） |

> 「标准页」= 首页/归档/说说/标签/文章（`variant="three-col"`）；「宽版页」= 搜索/友链（`variant="wide"`，永远两栏，上限 `--w-read`）。
> 这些是**计算值**，公式见 TD-3：三栏 `min(--w-main, vw − 64 − 288 − 320 − 80)`；两栏 `min(上限, vw − 64 − 288 − 40)`；单栏 `vw − 40`。
> 验收时以浏览器实测为准。若实测与表格不符 **> 2px**，处理顺序是：① 查实现（`padding-inline` 是否为 32×2、`max-width` 上限是否写对、有无额外 `margin`）；② 查断点条件（`min-width` 还是 `max-width`、1391/1392 是否写反）。**不要为了让断言通过而修改 TD-3 的设计参数，也不要回头改本表**——参数是设计决策，表格是它的推论。

### 10.4 基线截图策略

- 阶段 A 开始前：为 5 个代表性页面（`/`、`/archives`、`/shuoshuo`、`/friend-links`、`/search`）× **10 视口** × 2 主题拍一套基线（**100 张**），存 `.tmp-review/baseline/`。
- 每阶段结束后重拍，用 `pixelmatch` 之外的简单对比（本项目无图像库，建议人工抽查 + 关键元素尺寸断言，不做像素级 diff）。
- **`.tmp-review/` 已被 `.gitignore:36` 忽略**，不会误提交。它不在 `next.config.ts:110-121` 的 `outputFileTracingExcludes` 白名单里，但该列表已排除 `docs/**`、`tests/**` 等同类目录，若担心被 nft 追踪，可在 B 阶段顺手加一行 `.tmp-review/**`。

---

## 11. 测试与验收总表

| 命令 | 覆盖 | 阶段 A | B | C | D |
| --- | --- | --- | --- | --- | --- |
| `npm test` | 282 单测 | ✅ 每次提交 | ✅ | ✅ | ✅ |
| `npx tsc --noEmit` | 类型 | ✅ | ✅ | ✅ | ✅ |
| `npm run build` | standalone 构建 | ✅ | ✅ | ✅ | ✅ |
| `npm run test:next` | HTTP 集成（缓存/308/搜索/RSS） | ✅ | ✅ | ✅ | ✅ |
| `npm run test:browser` | 双页隔离 | | ✅ | ✅ | |
| `npm run test:friends` | 友链页 + 边界态 | | ✅ | ✅ | ✅ |
| `npm run test:dark` | 暗色（徽章/对比度） | | ✅ | ✅ | ✅ |
| `npm run test:ui` | 后台 UI kit（热区/对比度/375） | | | ✅ | ✅ |
| `npm run test:admin` | 后台导航与概览 | | | ✅ | ✅ |
| `npm run test:content` / `:comments` / `:media` / `:settings` | 后台各页 | | | ✅ | ✅ |
| `npm run test:integration` | 上述全部串联 | ✅ | ✅ | ✅ | ✅ |
| `node tests/layout-regression.mjs` | **新增**：10 视口布局矩阵（含 1392/1391） | | ✅ | ✅ | ✅ |
| `bash scripts/verify.sh` | tsc + test + build 三连 | ✅ | ✅ | ✅ | ✅ |

> `scripts/verify.sh` 是 CI 等价物（`.github/workflows/ci.yml` 同步），每个阶段收尾必须跑一次完整版。

**注意**：`npm run lint` 目前**不可用**（`next lint` 在 Next 16 已被移除，执行报 `Invalid project directory provided, no such directory: …/lint`）。本方案不依赖 lint；若要恢复，需单独引入 ESLint 配置（不在本次范围）。

---

## 12. 风险与回滚

### 12.1 风险总表

| 风险 | 触发任务 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- | --- |
| 日期补零导致 `hits` 历史区间错误 | A-1/A-2/A-3 | 高（若不迁移） | 后台统计失真 | 三者同批次；迁移前后对比 `range=all` 的 PV 必须相等 |
| **迁移把格式错误的 `day` 修成「看起来合法」的错误日期** | A-3 | 中（旧 GLOB 写法下必然发生） | 脏数据被洗白，事后无法识别 | 严格形状 GLOB（三条精确模式）+ `date(cand)=cand` 日历闸门；`2026-8-5-9` / `2026-8-5 12:00:00` / `2026-2-30` 三个用例必须断言「保持不变」 |
| **迁移把跨零点记录的日期平移一天** | A-3 | 中 | 月度分组与 `range=today` 偏移一天 | 只用 `printf` 补零，**不碰 `created_at`**；用例 `2026-9-30` + `created_at=2026-10-01T18:00Z` 断言仍为 `09-30` |
| 迁移在线上失败 | A-3 | 中 | 服务起不来（`getDb()` 在首个请求时跑迁移） | 迁移前备份；先在副本跑；迁移包在事务里 |
| 右栏去 overflow 后目录太长 | A-4 | 低 | 目录超出视口 | 目录单独 `sticky + max-height + overscroll-behavior:contain` |
| 三栏阈值提到 1392 后平板用户看不到右栏 | B-3 | 中 | 功能可发现性下降 | `.side-sheet-entry` 在 821–1391 都可见（已在 `Sidebar.tsx:49`） |
| `SiteShell` 改动波及 6 个页面 | B-1 | 中 | 页面白屏/错位 | 逐页迁移（一次一页一个 commit），每页跑一次 `test:next` |
| 友链页正文变窄 | B-4 | 中 | 观感 | 用 `--w-read:960` 兜住上限；若需更宽单独给 token（Q1） |
| 导航样式变化（padding/圆角） | B-7 | 高（必然） | 视觉变化 | 这是修复；截图确认与设计意图一致即可 |
| 暗色令牌重构引入色差 | C-2 | 中 | 全局观感 | 只抽值不改值；`test:dark` + 人工明暗对比 |
| `color-scheme` 改变表单外观 | C-3 | 低 | 后台控件外观 | 属预期改进；`test:ui` 覆盖 |
| 主题同步改坏首屏防闪烁 | C-4 | 中 | 暗色用户看到白闪 | 保留 `ThemeScript` 内联脚本不动；只改 `ThemeToggle` 的订阅 |
| 删死 CSS 误删动态类 | C-6 | 中 | 组件丢样式 | 先 grep 动态拼接（`"badge-" + tone`、`"nav-item" + (isActive ? …)`）再删 |
| 移动端标题变小 | C-6 | 高（必然） | 视觉变化 | 需求文档要求移动端可读；确认后执行（Q6） |
| 阶段 D 改视觉触碰后台类 | D-* | 中 | 后台样式崩 | 红线 #1；每页改完跑 `test:admin` |

### 12.2 回滚方案（分层）

> **所有生产操作（备份/迁移/部署/恢复）都必须先获得用户授权**，见第 0.2 节。下文的命令是"授权之后怎么做"，不是"可以直接跑"。

**（1）代码回滚（本地可做，无需授权）**

```bash
git revert <单个任务 commit>     # 一次只回滚一个任务
npm run build && npm run test:integration
```

> **不要用** `git reset --hard` / `git checkout -- .` / `git stash`：当前工作区有用户未提交的 `docs/` 改动，这些命令会一并毁掉。一律用 `git revert`（生成反向提交，不改历史，不动未提交文件）。

**（2）数据库回滚（仅阶段 A 需要，**需授权**）**

```bash
# ① 部署前手动快照（不停机）
ssh blog 'sqlite3 /var/lib/blog/blog.db ".backup /root/blog-backups/manual-$(date +%s).db"'
ssh blog 'sqlite3 /root/blog-backups/manual-<stamp>.db "PRAGMA integrity_check;"'   # 必须是 ok

# ② 需要回滚时（每一步都要你点头）
ssh blog 'systemctl stop blog'
ssh blog 'cp /var/lib/blog/blog.db /var/lib/blog/blog.db.broken'    # 先把坏库留证，不要删
ssh blog 'cp /root/blog-backups/manual-<stamp>.db /var/lib/blog/blog.db'
ssh blog 'systemctl start blog'
```

**回滚后的三件事**：
1. 保留 `blog.db.broken` 至少 7 天，用于事后分析脏数据形态；
2. 记录 `schema_version` 当前内容（`SELECT * FROM schema_version ORDER BY id DESC LIMIT 3;`）；
3. 把「哪一步出的错 / 观察到什么数字」写进实施记录，不要只说"回滚了"。

**关于 `schema_version`**：回滚代码后 0015 那行仍在表里，`migrate()` 不会重跑 —— 这不影响运行（迁移只前进）。只有确认要**重新**跑 0015 时才删那行，而删行本身也是生产写入，同样需要授权。

**（3）数据库结构回滚**

本次**不新增任何业务列/表**，0015 只 UPDATE `hits.day`。所以不存在结构回滚问题——恢复备份即可。`PRAGMA integrity_check` 与 `PRAGMA foreign_key_check` 在迁移前后都必须为 `ok` / 空。

**（4）部署回滚（**需授权**）**

```bash
/opt/blog/deploy.sh --list        # 看现有版本
/opt/blog/deploy.sh --rollback    # 回到上一版，等健康再报成功
```

`deploy.sh` 自己会在部署前调 `blog-backup`，并在健康检查失败时自动回滚——但"调用 deploy.sh"这个动作本身仍需授权。

**（5）分阶段回滚策略**

| 场景 | 做法 | 数据影响 |
| --- | --- | --- |
| 阶段 A 单个任务失败 | `git revert` 该 commit（本地）；若已迁移，走 (2) 恢复备份 | 可能需恢复库 |
| 阶段 A 整体失败 | `deploy.sh --rollback` + 恢复库快照 | 需恢复库 |
| 阶段 B 失败 | `deploy.sh --rollback` | 无（纯代码） |
| 阶段 C 失败 | `deploy.sh --rollback`；暗色可单独 revert 对应 commit | 无（纯代码） |
| 阶段 D 失败 | 同上；每页一个 commit，可只回滚某一页 | 无（纯代码） |

**（6）回滚演练（阶段 A 之前必做一次）**

在**备份副本**上演练一遍 (2) 的流程（不碰生产），确认：备份能被 `sqlite3` 打开、`integrity_check` = ok、`SELECT COUNT(*) FROM hits` 与源库一致、`schema_version` 可读。演练不做 = 回滚方案只是纸面承诺。

---

## 13. 需要你确认的技术决策

| # | 决策 | **默认方案**（未确认时按此执行） | 备选 | 风险标注 |
| --- | --- | --- | --- | --- |
| **Q1** | 两栏宽版正文上限 `--w-read` | **960px**（现友链页宽度；也适合搜索结果这种列表页） | 800px（与三栏中栏一致） | 🟡 **布局**：选 960 时，宽版页与标准页的宽度差是分段线性增长——`821–1191` 差 0（标准页未触 800 上限）、`1200` 差 8、`1300` 差 108、`1352` 起差 160 并保持（宽版页触 960 上限）；`≥1392` 因标准页变三栏，差值为 320（1392）→ 272（1440）→ 160（1552 起）。选 800 则两栏页宽度完全统一，但友链页会比现在窄。改动需重跑 10 视口矩阵 |
| **Q2** | 三栏阈值 | **1392px**（此视口中栏 640px，仍可读） | 1280px（中栏 528px，偏窄）/ 1440px（多数笔记本看不到右栏） | 🟠 **布局 + 行为**：1201–1391 区间的用户会从三栏变两栏，右侧统计/友链/标签云需点「侧栏」按钮。属可见行为变化，需一并更新第 10 节矩阵与 `test:friends` 断言 |
| **Q3** | 移动端导航文案 | **统一为 文章 / 说说 / 归档 / 友链 / 关于**（与桌面 `Sidebar` 一致） | 保留现状（首页 / 归档 / 说说 / 朋友 / 关于） | 🟡 **视觉**：移动端两处文案变化（首页→文章、朋友→友链），顺序也会变 |
| **Q4** | 友链页 `fr-footer` | **改为 `<div>`，保留文案**（页面只有一个 `<footer>` 地标） | 直接删除该区块 | 🟢 低。改标签会影响 `tests/friend-links-page.mjs` 的 `<footer` 计数断言（本方案会同步加） |
| **Q5** | 文章分类色（`categoryColor()`） | **保留内联 style**（数据驱动，7 个分类色） | 改为 CSS 变量 + `data-cat` 属性 | 🟡 **视觉**：改 class 要在渲染期生成 CSS 或用 7 个静态类；保留内联则暗色下由 `--cat-*-bg` 统一驱动，无额外风险 |
| **Q6** | 移动端 `.article-title` 改回 1.5rem | **改**（现 375px 下实测 32.8px，明显过大） | 保持 32.8px | 🟠 **视觉**：移动端文章标题从 32.8px 降到 24px，观感变化明显；这是需求文档「移动端适配」的必改项 |
| **Q7** | 58 个零引用 token | **先整体删除，再按需加回 12 个**（TD-7） | 保留并逐步启用 | 🟡 **视觉/结构**：删 97 行；若某处存在字符串拼接引用（已核对：无）才会断。`design-tokens.test.ts` 需加反向断言 |
| **Q8** | `0015` 迁移 vs 一次性脚本 | **两者都做**：迁移保证正确，脚本提供 dry-run | 只做脚本 | 🔴 **数据迁移**：迁移会**改写生产 `hits.day`**。必须备份 + 副本 dry-run + 用户授权（见 A-3 与 0.2） |
| **Q9** | 关于页是否独立路由 | **暂不新增**：继续 `app/[slug]/page.tsx` + `content/pages/about.md`，D-2 只在 `ArticleView` 加"关于页版式"（`doc.slug === "about"` 或新增 `variant` prop） | 新增 `app/about/page.tsx` | 🟡 **布局**：独立路由能做更自由的设计，但要自己处理 metadata / 评论 / TOC，且 `/about` 与 `[slug]` 并存需确保 `[slug]` 不再接管。**仅阶段 D 需要决定**，A/B/C 不受影响 |
| **Q10** | `getSettings().timezone` 死配置 | **本次不动**（`lib/time.ts:12` 只读 env；改默认值会影响全部日期展示） | 让 `formatIn` 默认值读 settings | 🔴 **数据/口径**：动它意味着所有日期展示跟着变，与本轮「补零但不改口径」的原则冲突。建议单独立项 |
| **Q11** | `npm run lint` 失效 | **不在本次修复**（`next lint` 在 Next 16 已移除，命令直接报错） | 引入 ESLint 9 flat config | 🟢 低。本次靠 `tsc --noEmit` + 282 个测试兜底 |

**风险图例**：🔴 = 涉及数据迁移或全局日期口径，必须授权；🟠 = 可见的布局/行为变化，需你确认；🟡 = 视觉或结构变化，影响可控；🟢 = 低风险。

**默认方案的含义**：
- 上表「默认方案」列即**未获回复时的执行口径**，不是"建议仅供参考"。
- 但**默认方案不等于授权**：Q8（数据迁移）无论是否默认，都必须在执行前单独获得你的明确同意。Q2/Q3/Q6 这类可见变化，会在 PR 描述里标注"按默认执行"，方便你事后单独回退。

---

## 14. 阶段 A 启动清单（可直接照着做）

> **本清单的 0–6 步全部在本地/临时库完成，不需要任何授权。**
> **14.2「上线」那一节才是生产操作，每一步都要单独获得你的授权。**
> 阶段 A 完成 ≠ 已上线；本地全绿只说明可以申请上线。

### 14.1 本地执行（Agent 可做）

```bash
# 0) 确认起点是绿的
npx tsc --noEmit && npm test            # 期望：tsc 0；tests 282 pass

# 1) 先写测试（A-1），此时应该红
#    编辑 tests/time.test.ts 增加 01/08/09/11 月断言
#    只跑 time.test.ts（注意：`npm test -- --test-name-pattern=…` 不会过滤，
#    因为脚本里已经固定了 tests/*.test.ts，额外参数不会生效 —— 实测 282 全跑）
node --experimental-strip-types --import=./tests/register.mjs \
     --test --test-name-pattern="monthKey" tests/time.test.ts    # 看它红

# 2) 改实现（A-1）
#    lib/time.ts 新增 isoDateIn；dateKeyIn 改调它
#    lib/posts.ts:155-164 跳过空 key；:171 label 从 key 取
npm test && npx tsc --noEmit            # 期望：全绿

# 3) A-2：hits 读写口径
#    lib/visitor-stats.ts 注释 + 读取侧合法性守卫
#    scripts/import-umami-events.mjs 统一用同一个生成器
#    tests/visitor-stats.test.ts 加混合格式断言

# 4) A-3：迁移（只在本地临时库验证，不碰 data/blog.db）
#    lib/migrations.ts 追加 0015_hits_day_isopad
#    scripts/normalize-hits-day.mjs（dry-run 默认，--apply 需显式传）
#    tests/migrations.test.ts 覆盖 T1–T20（含 T6–T15 共 10 类异常输入）
#    验证方式：直接用 tests 里的 :memory: 库，或 mkdtemp 一个临时目录：
#      node --experimental-strip-types --import=./tests/register.mjs --test tests/migrations.test.ts
#    若确实需要拿真实数据形态验证，先复制一份备份副本（见 14.2 第 1 步的产物），
#    DATA_DIR 指向 .tmp-tests/probe，再跑 dry-run / --apply：
DATA_DIR="$PWD/.tmp-tests/probe" node scripts/normalize-hits-day.mjs          # dry-run，只打印影响行数
DATA_DIR="$PWD/.tmp-tests/probe" node scripts/normalize-hits-day.mjs --apply  # 在副本上执行
DATA_DIR="$PWD/.tmp-tests/probe" node scripts/normalize-hits-day.mjs          # 再跑应输出「需要修正 0 行」

# 5) A-4 / A-5：纯 CSS（可与上面并行）
#    globals.css:547-553 去 max-height/overflow
#    globals.css:1815 补 */ 闭合

# 6) 阶段收尾（本地）
npm run build && npm run test:integration
```

**每完成一个任务就提交一次**（不要攒到阶段末）：

```bash
git add lib/time.ts lib/posts.ts tests/time.test.ts tests/posts-api.test.ts
git commit -m "A-1: 日期键补零，修复归档 NaN 月与月份排序"
# A-2 / A-3 / A-4 / A-5 同理，各自一个 commit
```

> 提交前先 `git status` 看清楚暂存了什么。**不要 `git add -A`**：会把用户原有的 `docs/` 改动一并卷进本次提交。

### 14.2 上线（**每一步都需要你单独授权**）

| 步 | 动作 | 授权形式 | 失败时的处置 |
| --- | --- | --- | --- |
| 1 | 生产备份 `blog-backup` + `integrity_check` | 你说"可以备份" | 备份失败 → 终止，不进行下一步 |
| 2 | 把备份拉到本地/临时目录，跑 dry-run，把「将改 N 行 / 待人工 M 行」报给你 | 无需额外授权（只读副本） | 数字异常 → 终止 |
| 3 | 你确认数字后，授权部署 | 你说"可以部署" | 部署失败 → `deploy.sh --rollback` |
| 4 | 部署后核对 `/admin/visitors?range=all` 的 PV 与部署前一致 | 只读核对 | 不一致 → 立即回滚 + 恢复备份 |
| 5 | 核对 `/archives` 无 `NaN`、1–12 月顺序、条目日期 `MM/DD` | 只读核对 | 异常 → 记录并回报 |

**A-3 的待人工清单（M 行）怎么处理**：不在本次自动修。把清单给用户，由用户决定每条是"改成某天"还是"留空"。**Agent 不得自行猜测日期**。

---

## 15. 一页速查

| 阶段 | 任务数 | 关键产出 | 最大风险 | 准出信号 |
| --- | --- | --- | --- | --- |
| A | 6 | `isoDateIn` + 0015 迁移（严格 GLOB + 日历闸门）+ 两处 CSS 修复 | 迁移改写生产 `hits.day`（不可逆） | `/archives` 无 NaN，`range=all` PV 不变，待人工清单已交你确认 |
| B | 8 | `SiteShell` + `--w-shell` + `nav.ts` | 7 处骨架同时改 | 10 视口矩阵绿，友链左栏对齐 |
| C | 9 | 令牌体系 + 主题同步 + 组件合并 | 暗色与后台共享令牌 | `test:dark`/`test:ui`/`test:admin` 绿 |
| D | 5 | 逐页视觉 | 触碰后台类 / 过度设计 | 需求文档第十二节逐条通过 |

---

## 16. 修订记录（v1 → v1.1，2026-10-31）

本次修订只改本文档，未触碰源码/CSS/数据库/测试。

| # | 修订点 | 原状态 | 现状态 |
| --- | --- | --- | --- |
| 1 | A-3 的 `GLOB` 条件 | `'…-[0-9]*-[0-9]*'`，`*` 会吞掉任意尾巴 | 三条**精确形状**模式，且必须在此结束；`2026-8-5-9` / `2026-8-5 12:00:00` 不再被误改 |
| 2 | A-3 的日历有效性 | 无校验，`2026-2-30` 会被写成不存在的日期 | 新增 `date(cand) = cand` 闸门，非法日历日一律不动 |
| 3 | A-3 的脏行处理 | 用 `created_at` 兜底改写（会平移一天） | **完全不碰 `created_at`**；脏行原样保留 + 输出待人工清单 |
| 4 | A-3 的测试 | 3 行样本 | **T1–T20**，含 T6–T15 共 10 类异常输入（非数字月/日、非法日历日、越界月/日、空串、纯空格、带时间、多段、垃圾串） |
| 5 | A-3 的权限 | 只写"必须备份" | 新增**生产操作授权门**：迁移/备份/部署/恢复逐项需用户点头；Agent 不得自行执行 |
| 6 | 响应式矩阵 | 8 视口，缺断点专测 | **10 视口**，新增 V2=1392（三栏最低点）/ V3=1391（两栏最高点） |
| 7 | B-3 验收标准 | "1201/1200/1100 三档宽度差 < 30px"（与 92px 的实测值矛盾） | 改为「断点内连续性 + 断点切换点唯一」两组可验证断言，并写明哪个跳变是预期 |
| 8 | 技术决策编号 | `D-1…D-8`（与阶段 D 的 `D-1…D-5` 冲突） | **`TD-1…TD-8`**；阶段 D 的视觉任务仍是 `D-1…D-5` |
| 9 | 决策表 | 列名"推荐"，含义模糊 | 列名改为「**默认方案**」，并加风险图例（🔴/🟠/🟡/🟢）与"默认 ≠ 授权"说明 |
| 10 | 执行边界 | 分散在各处 | 新增 **§0.2**：本地/临时库/生产三类环境 + 授权清单 + Git 纪律 |
| 11 | 回滚方案 | 用 `git checkout master`（会丢未提交修改） | 改为 `git revert`；明确禁止 `reset --hard` / `stash` / `checkout -- .`；新增恢复演练要求 |
| 12 | 提交纪律 | 只在 A-6 提了一句 | **§0.2 ④** 与 **A-6 提交要求**：一任务一 commit，不 squash；阶段末停下来等验收 |

**编号自查结果**：阶段任务 A-1…A-6 / B-1…B-8 / C-1…C-9 / D-1…D-5，技术决策 TD-1…TD-8，待确认项 Q1…Q11，章 0–17，均无重号、无断号；`D-` 前缀只出现在阶段 D 的五个视觉任务（`D-1…D-5`）与其小节号（`D.1…D.4`）中，`TD-` 只出现在第四章。

---

## 17. 仍然存在的风险（修订后）

以下是本次修订**没有消除**、需要你在执行时留意的点：

| # | 风险 | 为什么修订不能消除 | 建议 |
| --- | --- | --- | --- |
| R1 | **线上 `hits` 的真实脏数据分布未知** | 本地库 `hits` 为 0 行，无法推断生产形态；迁移只对"形状可判定"的行动手，实际可能仍有几十行进待人工清单 | 上线前在生产备份副本上跑一次 dry-run，把「将改 N 行 / 待人工 M 行」的数字贴给你；若 M 很大，先暂停讨论 |
| R2 | **日历闸门依赖 SQLite 的进位行为** | `date('2026-02-30')` → `2026-03-02` 是 SQLite 的实现行为，不是 SQL 标准；未来换数据库（或 SQLite 改行为）时该判据会失效 | 迁移注释里写明这个依赖；`tests/migrations.test.ts` 的 T8 用例把行为钉死，升级 SQLite 时测试会先报错 |
| R3 | **读取侧形状守卫不判日历合法性** | `GLOB` 只能拦"形状不对"的值；`2026-13-01` / `2026-02-30` 仍能通过。要判日历必须用 `date()`，那会让索引失效 | 接受这个边界：迁移已把非法日历日排除在自动修复之外并列入人工清单；只有人工确认后才会进库 |
| R4 | **三栏阈值 1392 是设计参数，不是实测最优** | 它由 `64+288+320+80+640` 推导而来（"中栏至少 640px"），640 这个下限本身是经验值 | 阶段 B 完成后用真实内容跑一遍，若觉得 640 偏窄，需要重新讨论阈值——但那会牵动 Q1/Q2 与第 10 节整张表 |
| R5 | **10 视口矩阵仍是抽样** | 只测 10 个宽度，不保证 821/820、1391/1392 之外没有其他边界问题（如浏览器缩放 110%、125%） | 阶段 B 额外做一次「连续缩放扫」（1190→1400，每 10px 记录一次 `.content` 宽度），确认除 1392 外无其他跳变 |
| R6 | **`--w-read` 与 `--w-main` 双上限增加理解成本** | 两个上限（800 / 960）意味着"正文宽度"不是单一概念 | 若后续觉得难维护，可退化为单上限 + 页面级 `max-width`；但那会重新引入"每页自己算宽度"的问题（TD-4 想解决的正是这个） |
| R7 | **阶段 D 的视觉判断无法自动化** | 截图对比只能发现"变了"，不能判断"变好没有" | D 阶段每页必须人工评审；本方案只保证"地基稳定"，不保证"好看" |

**一句话**：这次修订解决的是**方案自身的安全性、可验证性与编号一致性**；不能替代"在生产数据上的实测"和"人对视觉的判断"。
