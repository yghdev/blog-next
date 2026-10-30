# 访客统计方案分析（对标 VisitorLoggerPro）

> 制定时间：2026-10-30
> 状态：**仅分析，未实现**
> 参考对象：`blog.ybyq.wang/archives/97.html`（Typecho 插件 VisitorLoggerPro v2.4.0）
> 相关文件：`lib/site-stats.ts`、`lib/settings.ts`、`scripts/sync-umami.mjs`、
> `components/Analytics.tsx`、`app/layout.tsx`、`lib/migrations.ts`、`lib/time.ts`

---

## 0. 结论与需求确认

需求收敛为四条（2026-10-30 确认）：

| # | 需求 | 落到指标上 |
| --- | --- | --- |
| 1 | 访客 / 访问总量 | PV（访问总量）、UV（访客总量）、访问次数（会话） |
| 2 | 单文章 / 页面访问量 | 每个 `path`（能对上文章则按 `post_id`）的 PV |
| 3 | 访客来源 | 按「入口来源」归因：直接 / 搜索引擎 / 社交 / 外链 / 站内 |
| 4 | 排除管理员（我） | 带有效后台会话的请求一律不记 |

**结论**：自建一个最小埋点即可，一张表 + 一个接口 + 一个后台页，
**不需要照搬参考插件**（它面向 90 万条日志的 MySQL 站点，本站是 193 天 1151 PV，
复杂度差约 780 倍）。展示层与取数层已经解耦干净（`lib/site-stats.ts` 是唯一入口），
换数据源不用动任何页面组件。

---

## 1. 参考实现拆解

### 1.1 它做了什么

| 能力 | 具体功能 |
| --- | --- |
| **计数** | PV、独立 IP、UV、访问次数（会话） |
| **归属** | 国家 Top30、省份 Top30、IP 分布、路由 Top20、按时间分布 |
| **筛选** | 日期范围 + 9 个快捷区间；单日自动切小时粒度 |
| **治理** | 管理员排除、爬虫 UA 过滤（含 GPTBot / Claude / Headless）、IP 忽略名单 |
| **展示** | ECharts 四曲线、环形图、柱状图、列表视图、AJAX 翻页、移动端适配 |

它面向 **90 万+ 日志**，靠索引与 SQL 聚合把加载从 10s 压到 2s，跨度 >30 天缓存 15 分钟。

### 1.2 值得抄的三条

**① 无 Cookie 的访客标识**

```
visitor = hash(站点, IP, User-Agent, 盐)
```

不种追踪 Cookie；前端只上报 `url / referrer / title`，**身份全部在服务端算**。

**② 会话 = 30 分钟无活动**

**③ 爬虫与管理员在写入侧排除**（不是先写再过滤）

### 1.3 它的复杂度来自哪里（本站不需要）

| 模块 | 成本 | 对本站 |
| --- | --- | --- |
| 国家 / 省份 | IP 地理库 10–20MB，按月更新 | ≈0，个人博客不需要 |
| IP 分布 / 按 IP 删除 | 要存原始 IP | **负值**，与隐私目标冲突 |
| 独立 IP + UV 双指标 | 无 Cookie 下高度重合 | 只留 UV |
| 三种统计模式 | 三套写入路径 | 只做前端埋点 |
| 四指标四曲线 | 图表库 + 调优 | 两条线或柱状即可 |
| MySQL 版本回退 / Typecho 适配 | 老环境兼容 | 不存在 |
| 90 万行索引调优 | 数据量 | 不存在 |

---

## 2. 本站现状体检

### 2.1 现有链路

| 环节 | 位置 | 作用 |
| --- | --- | --- |
| 采集 | `components/Analytics.tsx` → Umami `script.js` | 浏览器端自动上报 |
| 存储 | Docker：Umami + Postgres（`deploy/umami/`） | 原始事件在 Postgres |
| 同步 | `scripts/sync-umami.mjs` + `deploy/umami-sync.timer`（5 分钟） | 拉总 PV 与各路径 PV → `settings` 表 |
| 读 | `lib/site-stats.ts` 的 `getPageViews` / `getViewsMap` / `getSiteStats` | 读 `umami:path:*` |
| 展示 | 文章页「N 次浏览」、首页卡片徽章、侧栏「访问」 | 已有 UI |

### 2.2 六个具体问题

**① 「访问」是近 365 天滚动值，不是累计**

`sync-umami.mjs:44` 写死 `start = end - 365 * 86400000`。站龄 193 天还看不出来，
满一年后会开始「掉数字」，但标签写的是「访问」。

**② 总访问与单篇口径割裂（2026-10-30 线上实测）**

- 侧栏「访问」= **1151**（全站 PV，含首页 / 归档 / 标签 / 失效旧 URL）
- 首页 14 篇 + 第二页 3 篇卡片徽章相加 = **59**

两个数都对，但读者会当成一回事。新页面必须把「全站 PV」与「文章 PV」分开写。

**③ 后台也在被统计**

`app/layout.tsx:86` 的 `<Analytics />` 在 `<FrontOnly>` 之外，
实测 `/admin/login` 的 HTML 里有 `umami.yghsite.cn/script.js`。若 Umami 侧没配排除，
Top 页面里会混进 `/admin/*` —— 这正好对应需求 4。

**④ 统计存在 `settings` 这个 KV 表里**

`umami:path:*` / `umami:total` 是把分析结果塞进配置表：没有时间维度、不能按区间查、
不能算 UV、不能归因来源。**这是当前方案的天花板。**

**⑤ 依赖 344MB 的 Docker 邻居**

`deploy/README.md:148`：umami 320MB + db 180MB，实测约 344MB，
且**不在每日备份里**（`deploy/README.md` 明确写了）。

**⑥ 没有原始事件，历史不可回溯**

只有聚合后的 PV，改口径就得重来。

> 小瑕疵：`sync-umami.mjs:65-66` 把 `umami:total` 在同一事务里写了两遍，无害。

### 2.3 一个容易被忽略的现状

「N 次浏览」**目前只在 `[slug]` 模板里渲染**（文章页 + 关于页这类 `type=page` 的页面）。
`/archives`、`/shuoshuo`、`/friend-links`、`/tags/*` 这些固定路由**都不显示浏览量**。
所以需求 2 要分两层看：

- **前台可见**：`[slug]` 页面继续显示单篇浏览量（`app/[slug]/page.tsx:66`）；
- **后台可见**：所有路径（含固定路由）的 PV 都在访客页的 Top 列表里。

---

## 3. 四条需求的口径定义

先把「一个词对应哪条 SQL」钉死，否则做完一定会扯皮。

| 指标 | 定义 | SQL | 展示位置 |
| --- | --- | --- | --- |
| **PV（访问总量）** | 每记一条 hit 就是 1 | `COUNT(*)` | 侧栏「访问」、后台 |
| **UV（访客总量）** | 去重后的 `visitor` | `COUNT(DISTINCT visitor)` | 后台 |
| **访问次数（会话）** | 30 分钟无活动切一次 | `SUM(is_entry)` | 后台 |
| **单篇 PV** | 按 `post_id` / `path` 聚合 | `GROUP BY post_id` | 文章页「N 次浏览」、后台 Top |
| **来源** | 会话首次落地页的 referrer | `WHERE is_entry = 1 GROUP BY ref_kind` | 后台 |

两个必须写在页面上的说明：

1. **UV 是近似值**。无 Cookie 方案下，换浏览器、清缓存、手机切 WiFi/4G、
   **浏览器自动升级改了 UA**，都会被算成新访客。参考插件也承认这一点（月盐轮换）。
2. **访问次数 ≠ PV**。一次访问里看 3 篇文章 = 1 次访问、3 PV。

---

## 4. 方案选型

### 4.1 四个候选

| | A. 维持 Umami | B. 自建轻量埋点 | C. 纯服务端计数 | D. 解析 nginx 日志 |
| --- | --- | --- | --- | --- |
| 准确性 | 高 | 高 | 低 | 中 |
| 抗爬虫 | 中（不执行 JS 的爬虫天然不报） | 中（同上 + UA 过滤） | **差** | 差 |
| 能区分真实导航 | 是 | 是 | **否**（prefetch / RSC 都算） | 否 |
| 来源归因 | 有 | 有（需处理 SPA 坑） | 有（但被预取污染） | 有 |
| 外部依赖 | Docker + Postgres | 无 | 无 | 无 |
| 进每日备份 | 否 | **是**（同一个 `blog.db`） | 是 | 否 |
| 隐私 | 无 Cookie | 无 Cookie + 不存 IP | 不存 IP | 存原始 IP |
| 工作量 | 0 | 1.5 天 | 0.5 天 | 1 天 |

### 4.2 为什么选 B

- 数据进备份（`blog-backup` 备份的就是 `blog.db`）
- 口径可解释，一条 SQL 一个指标
- 以后加「热门文章」只是加 `GROUP BY`
- 能去掉 344MB 的 Docker 邻居（P2 之后）

### 4.3 为什么 C 不行

Next 16 App Router 下一次「页面访问」在服务端有多种形态：

| 请求特征 | 是什么 | 算不算 |
| --- | --- | --- |
| `RSC: 1` | 客户端路由的 RSC 载荷 | 算（但与 HTML 可能成对） |
| `next-router-prefetch: 1` | `<Link>` 预取，**用户没点** | **不算** |
| `next-router-state-tree` | 路由预取 | 不算 |
| `GET` + `Accept: text/html` | 首屏导航 | 算 |

线上响应头里确实有
`Vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch`。
在服务端分辨这些比发一个 beacon 更容易出错，而且**永远分不清人和 curl**。

---

## 5. 推荐设计（只定契约）

### 5.1 数据模型：一张表

```sql
CREATE TABLE hits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  path          TEXT    NOT NULL,               -- 归一化路径：以 / 开头、无 query、无尾斜杠
  post_id       INTEGER,                        -- 能对上文章/页面就填（服务端解析，不信客户端）
  visitor       TEXT    NOT NULL,               -- HMAC(secret, ip|ua) 前 16 位 hex
  is_entry      INTEGER NOT NULL DEFAULT 1,     -- 本次是否为「新会话的第一条」
  ref_host      TEXT    NOT NULL DEFAULT '',    -- 只存域名
  ref_kind      TEXT    NOT NULL DEFAULT 'direct', -- direct/search/social/referral/site
  day           TEXT    NOT NULL,               -- YYYY-MM-DD（展示时区预计算）
  created_at    TEXT    NOT NULL                -- UTC ISO
);
CREATE INDEX idx_hits_day      ON hits(day);
CREATE INDEX idx_hits_post_day ON hits(post_id, day);
CREATE INDEX idx_hits_path_day ON hits(path, day);
CREATE INDEX idx_hits_visitor  ON hits(visitor, created_at);
```

**三个字段是为了三条需求专门存在的，不是凑数**：

- `post_id`：slug 会改（项目已有 `post_aliases` 表），按 id 聚合不会把浏览量拆成两条。
  服务端解析（`posts` 有 `UNIQUE(type, slug)` 覆盖索引，一条查询即可），**客户端传的 id 不可信**。
- `is_entry`：**一列同时解决「来源归因」和「访问次数」**（见 5.3）。
- `day`：SQLite 的 `date(created_at)` 会让索引失效，且没有时区库。
  写入时用 `lib/time.ts` 的 `DISPLAY_TZ` 算好日期，聚合就是纯 `GROUP BY day`。
  （参考实现也提到「避免 `DATE(time)` 破坏索引」，同一个坑。）

**为什么不做「原始表 + 累计表」两张**：个位数 PV/天，一年约 2200 行，
累计值就是一个 `COUNT(*)`，UV 随时可按区间重算。等 `hits` 超过 50 万行再拆，是纯加法。

**为什么没有 `ua_kind` 列**：爬虫在写入前就被 UA 黑名单挡掉了，不落库。
真要看「被挡了多少」，用日志/计数器，不值得为它加一列。

### 5.2 身份与管理员排除（需求 4）

```
visitor = HMAC-SHA256(STATS_SECRET, ip + "|" + ua).slice(0, 16)
```

- **必须 HMAC，不能裸 SHA-256**：IPv4 只有 2^32，裸哈希可被穷举反查。
  `lib/crypto.ts` 目前只有 `hashToken`，需要补一个 `hmac()`。
- 原始 IP **不落库**，只在内存里参与一次计算（`lib/request-ip.ts` 已能给可信 IP）。
- **盐不按月轮换**：本站要的是「访客总量」这个能长期比较的数字。
  月盐会让一年访问 12 次的老读者被算成 12 个访客（已实测），总额直接失去意义。
  代价是 pseudonym 稳定 —— 但它不外泄、不种 Cookie、不跨站，风险可接受。
  secret 存 `settings`（`INSERT ... ON CONFLICT DO NOTHING` 后回读，天然防并发双写）。

**管理员排除**（这一条最容易做错）：

```ts
// 一次主键查询，不 join users，不写任何东西
const token = req.cookies.get("blog_session")?.value ?? "";
if (token && db.prepare(
  "SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?"
).get(hashToken(token), new Date().toISOString())) return;  // 不记
```

已实测：`sessions.token_hash` 是主键，命中走 `sqlite_autoindex_sessions_1`；
过期/未知 token 均 miss。三点注意：

1. **不要用 `currentUser()`**：它会顺带 `UPDATE sessions SET last_seen_at`，
   等于让「统计一次浏览」产生一次写库，得不偿失。
2. **不要靠前端判断**：前端拿不到 `httpOnly` cookie 的内容；
   必须用 `fetch(..., { credentials: "same-origin" })` 让浏览器带上，服务端判。
3. **覆盖两种场景**：后台页面（`/admin*` 已被路径过滤挡掉）+ **登录状态下浏览前台**（这才是主要场景）。

不需要开关。想验证「记录是否生效」，开个无痕窗口即可。

### 5.3 写入路径

```
浏览器（FrontOnly 内） → POST /api/hit → 过滤链 → 写 hits
```

过滤链（任一步不通过 → 204，不写）：

| 步骤 | 规则 | 目的 |
| --- | --- | --- |
| 1. 来源校验 | `Sec-Fetch-Site: same-origin`，缺失时校验 `Origin`/`Host` | 挡跨站刷量 |
| 2. 路径校验 | 以 `/` 开头、≤200 字符、不含 `//`、不以 `/admin` `/api` `/_next` `/preview` 开头 | 防脏数据 |
| 3. UA 过滤 | 正则黑名单（bot/spider/crawl/headless/gptbot/claude/curl/wget/python-requests…） | 爬虫不计 |
| 4. 管理员排除 | 见 5.2 | 需求 4 |
| 5. 限流 | 同 IP 10 分钟 120 次（复用 `lib/rate-limit.ts`） | 防刷 |
| 6. 归一化 | path 去 query / 尾斜杠 / 解码，slug → `post_id` | 读写同一套 key |

**`is_entry` 用一条原子 SQL 算，不需要先读后写**（已实测）：

```sql
INSERT INTO hits (path, post_id, visitor, is_entry, ref_host, ref_kind, day, created_at)
SELECT ?, ?, ?,
       CASE WHEN EXISTS (
         SELECT 1 FROM hits WHERE visitor = ? AND created_at > ?   -- 30 分钟窗口
       ) THEN 0 ELSE 1 END,
       ?, ?, ?, ?
```

`visits = SUM(is_entry)`，`来源 = WHERE is_entry = 1`，两者共用同一列。

**前端触发时机**（比后端更决定准不准）：

- 首挂载 + `usePathname()` 变化各报一次（与 `components/ScrollReset.tsx` 同一套模式）；
- 跳过 `pageshow.persisted === true`（bfcache 恢复不算新访问）；
- 开发环境 StrictMode 会双调用 effect → 模块级 `lastReported` 去重；
- `fetch(..., { keepalive: true, credentials: "same-origin" })`，失败静默 ——
  **统计永远不能影响页面**。

### 5.4 来源归因的三个坑（需求 3 的真正难点）

**坑 1：SPA 里 `document.referrer` 是「陈旧」的**

`document.referrer` = 本文档加载时的来源，**客户端路由不会更新它**。实测语义：

| 场景 | `document.referrer` | 正确归属 |
| --- | --- | --- |
| 从 Google 点进 A 页（首次加载） | `https://www.google.com/` | 搜索 |
| 点站内链接进 B 页（SPA 跳转） | **仍是 Google**（不变） | 应为「站内」 |
| 刷新 B 页 | `https://blog.yghsite.cn/B` | 站内 |
| 直接输入 / 书签 | `""` | 直接 |

若每条 hit 都带 referrer，那么**一次 Google 来的访问会把后续 10 个 PV 都记成 Google**，
来源报表会系统性高估外部渠道。

**解法**：**只有 `is_entry = 1` 的那条 hit 参与来源归因**，其余全部记为 `site`（站内）。
这与「访问次数 = `SUM(is_entry)`」天然一致 —— 一个会话只有一个来源。

**坑 2：`Referrer-Policy` 已经帮我们剪掉了 path**

`next.config.ts:80` 是 `strict-origin-when-cross-origin`：跨站时只给 origin，
同站时给完整 URL。所以：

- 外部来源本来就只有 `https://www.google.com/`，**存 `host` 就够了**，不损失信息；
- 站内来源会带完整路径，但我们不需要（归为 `site`）。

**结论**：服务端只保留 `ref_host`（小写、去端口、去 `www.`），**绝不存完整 URL** ——
既少存隐私数据，也避免把别人的搜索词存进来。

**坑 3：客户端可以伪造 referrer**

它只影响来源报表，不影响 PV/UV。可接受；限流已限制批量刷。
若要更严格，可校验 `ref_host` 不在自家域名列表里。

**分类规则**（写死一张小表即可，约 20 个域名）：

```ts
// ref_host === ""                        -> direct
// ref_host === 本站域名                   -> site
// google/bing/baidu/duckduckgo/yandex... -> search
// x.com/twitter/weibo/zhihu/v2ex/discord -> social
// 其他                                    -> referral
```

### 5.5 读取路径

| 消费点 | 现有函数 | 改造 |
| --- | --- | --- |
| 文章页「N 次浏览」 | `getPageViews(path)` | 按 `post_id` 聚合，回退到 path |
| 首页卡片徽章 | `getViewsMap()` | 一次 `GROUP BY post_id` 取全量，仍返回 Map |
| 侧栏「访问」 | `getSiteStats()` 的 `umamiTotal` | `SELECT COUNT(*) FROM hits` |
| 后台访客页 | 新增 | 见 5.6 |

**函数签名不变**，页面组件一行都不用改。
但浏览量缓存要单独给 **60s TTL**（现在全站统一 300s，新数字最多晚 5 分钟出现，
看起来像「统计坏了」）；其余统计仍可用 300s。

### 5.6 后台「访客」页

放 **系统** 组（`components/admin/nav-config.ts`），与「日志」相邻 —— 都是观测类。

```
PageHeader（眉标「系统 · 观察」 + 衬线标题「访客」）
  ├ .fx-figure-row   今日 PV / 今日 UV / 今日访问数 / 累计 PV      ← 一行数字 + 上下细线
  ├ 14 天柱状（内联 SVG，不引图表库）
  ├ 来源 Top（direct / search / social / referral + 具体域名）
  └ 页面 Top 10（.data-panel + .data-row，数值右对齐 tabular-nums）
```

URL 直接带范围参数（`?range=7d|30d|all`），与 `/admin/audit?group=` 同一套模式 —— 可分享、可刷新。

两条约束：

1. `docs/admin-redesign-implementation.md:457` 写过「概览不做装饰性访问量大屏」。
   所以**访客页不进概览、不占首屏**，它是查看型页面。
2. **不引入 ECharts**。项目现在零图表依赖，为一张 14 天柱状图加 200KB 不值；
   内联 SVG 画 14 根 `<rect>`，用 `currentColor` + `--fx-brand` 自动跟随暗色主题。

### 5.7 回填、清理与下线

- 新迁移 `0013_page_views`（`MIGRATIONS` 按 name 排序，追加即可）。
- **历史数据用「基线偏移」，不伪造 hit 行**。
  上线前 `settings` 里已经有 `umami:path:<path>` 与 `umami:total`，**原样留着别删**，
  读取时相加即可：

  ```ts
  // 单篇：本地 hits 计数 + 上线前的历史值
  views = COUNT(hits WHERE post_id = ?) + baseline("umami:path:" + path)
  // 全站：同上
  total = COUNT(hits) + baseline("umami:total")
  ```

  **为什么不用「伪造一条 visitor='baseline' 的 hit」**：那条假记录会污染
  `COUNT(DISTINCT visitor)`（UV 平白 +1）、`SUM(is_entry)`（访问次数 +1）、
  以及来源报表。而这些指标本来就只从上线那天起算，没有任何历史可补。
  基线只该加在「PV」这一个维度上 —— 用一个加法就能表达，不必动表。
- **清理**：暂时不需要（一年 2200 行）。要加时用
  `DELETE FROM hits WHERE created_at < ?`，注意 SQLite 删行后文件不会变小。
  基线在 `settings` 里，不受清理影响。
- **下线 Umami（P2）**：删 `components/Analytics.tsx`、`scripts/sync-umami.mjs`、
  `deploy/umami*`、`next.config.ts` 的 `umamiOrigin`。
  **但 `settings` 里的 `umami:*` 基线要留着**（它是历史 PV 的唯一副本），
  只把 `lib/settings.ts` 的 `umamiTotal` 字段改名/注释为「历史基线」。

---

## 6. 改动面

**新增**

| 文件 | 内容 |
| --- | --- |
| `lib/visitor-stats.ts` | 写入、过滤链、路径归一化、来源分类、聚合查询 |
| `app/api/hit/route.ts` | beacon 接口（POST，无鉴权，有限流） |
| `components/VisitorBeacon.tsx` | 客户端上报（`usePathname` 驱动） |
| `app/admin/visitors/page.tsx` | 后台访客页 |
| `tests/visitor-stats.test.ts` | UA 过滤、路径归一化、来源分类、`is_entry` 窗口、管理员排除 |

**修改**

| 文件 | 改动 |
| --- | --- |
| `lib/migrations.ts` | 追加 `0013_page_views` |
| `lib/site-stats.ts` | 三个读函数改数据源 |
| `lib/cached.ts` | 浏览量缓存单独 60s |
| `lib/crypto.ts` | 补 `hmac()` |
| `app/layout.tsx` | `<VisitorBeacon />` 放进 `<FrontOnly>` **内** |
| `components/admin/nav-config.ts` | 系统组加「访客」 |
| `components/admin/AdminShell.tsx` | `NAV_ICONS` 加一个图标键 |

**注意**：`app/api/hit` 不在 `/api/admin/*` 下，`proxy.ts` 不拦它 —— 这是对的，
但意味着**限流与来源校验必须自己写**。`app/robots.ts` 已 `disallow: /api`。

---

## 7. 工作量与风险

| 阶段 | 内容 | 估时 |
| --- | --- | --- |
| P0 | 表 + 接口 + beacon + 三个读函数 + 前台数字 | 0.5 天 |
| P1 | 后台访客页 + 14 天柱状 + 来源 Top + 页面 Top10 | 0.5 天 |
| P2 | 双跑对账 + 下线 Umami + 隐私说明 | 0.5 天 |

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| **中文 slug 编码不一致** | 文章浏览量恒为 0 且不报错 | 读写共用 `normalizePath()`（含 `decodeURIComponent`）；优先按 `post_id`；测试断言「编码输入与解码输入同 key」 |
| SPA 陈旧 referrer | 外部来源被系统性高估 | 只对 `is_entry = 1` 归因（5.4） |
| UV 长期偏高 | 数字不可比 | 固定盐 + 页面写明「近似值」；改用月盐只会更糟 |
| 客户端导航漏报/重报 | 数字偏大或偏小 | `usePathname` + 模块级去重 + 跳过 bfcache |
| 回填漏了旧数据 | 上线当天归零 | 用 `settings` 里的 `umami:*` 做基线偏移（5.7），测试断言「基线 + 新增」 |
| 管理员的访问被记进去 | 数据被自己污染 | 服务端查 `sessions`（5.2），不依赖前端 |
| 广告拦截器拦上报 | 少记 | 路径用中性名 `/api/hit`，同源，不用 `analytics/track/collect` |
| 后台页变成「好看但没人看」 | 白做 | 4 个数字 + 两个 Top10，不放大屏、不加图表库 |

---

## 8. 仍需拍板

1. **UV 的盐**：固定盐（推荐，总量可比）／ 月盐（更隐私，但总量≈PV）？
2. **侧栏「访问」显示什么**：PV 累计（推荐，与现在语义一致）／
   访问次数（更接近「来过几次」的直觉，但数字会小很多）？
3. **后台深度**：4 数字 + 14 天柱状 + 来源 Top + 页面 Top10（推荐）／ 再加最近访问明细？
