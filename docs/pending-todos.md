# 待办事项（技术债 / 已知问题）

> 本文件记录**已确认存在但暂不处理**的问题。每一条都写清楚：现象、证据、
> 影响范围、为什么现在不修、以及将来修的时候要注意什么。
>
> 目的：不让这些问题靠"记在脑子里"流传 —— 那种记忆会在两次重构之间消失，
> 然后同一个坑被重新踩一遍。

---

## 1. `revalidateTag(TAGS.stats)` 不刷新 `getSettingsCached`

**记录时间**：2026-11-01（阶段 C-9 实施时发现）
**状态**：🔴 未修复，**暂不处理**（用户决定：等所有改版工作完成后再单独处理）
**优先级**：🟠 中高（影响后台改设置后的生效延迟）

### 现象

在后台保存站点设置（`PUT /api/admin/settings`）后：

- `/rss.xml`（走 `getSettings()` **直读**，不经 `unstable_cache`）→ **立即**显示新站名 ✅
- 首页 `<title>`（`generateMetadata` 里的 `getSettings()`）→ **仍然是旧站名** ❌
- 首页侧栏 `.brand-title`（`SiteShell` 里的 `getSettingsCached()`）→ **仍然是旧站名** ❌

### 复现步骤

```bash
# 1) 启隔离实例
# 2) 先访问一次首页（让 unstable_cache 建立条目）
curl -s http://127.0.0.1:PORT/ > /dev/null

# 3) 改设置
curl -X PUT http://127.0.0.1:PORT/api/admin/settings \
  -H 'content-type: application/json' -b "$COOKIE" \
  -d '{"siteTitle":"新站名","siteDescription":"新简介"}'

# 4) 连续请求首页
for i in 1 2 3 4 5 6; do curl -s http://127.0.0.1:PORT/ | grep -o 'class="brand-title">[^<]*'; done
# 实测：6 次全是旧值

# 5) 等 15 秒（超过 lib/settings.ts 的 10s 进程内 TTL）再请求
# 实测：仍是旧值

# 6) 同一时刻对比 RSS
curl -s http://127.0.0.1:PORT/rss.xml | grep -o '<title>[^<]*'
# 实测：立即是新值
```

### 已排除的可能

| 假设 | 验证 | 结论 |
|---|---|---|
| `updateSettings` 忘了失效进程内缓存 | 读 `lib/settings.ts:102`，确实调了 `invalidateSettingsCache()` | ❌ 不是这个 |
| 后台没调 `revalidateTag` | `app/api/admin/settings/route.ts:48` 有 `invalidate([TAGS.posts, TAGS.stats])` | ❌ 不是这个 |
| tag 名字写错 | `TAGS.stats = "site-stats"`，`getSettingsCached` 用的也是它 | ❌ 不是这个 |
| 只是 SWR 的一次延迟 | 连请求 6 次（间隔 500ms）+ 等 15s，全不变 | ❌ 不是这个 |
| 整页被缓存 | `app/page.tsx` 有 `export const dynamic = "force-dynamic"` | ❌ 不是这个 |

### 反向对照：`TAGS.posts` 是好的

同一套 `invalidate` 机制对文章生效：

```bash
# 建一篇已发布文章（走 API，会 invalidate TAGS.posts）
# 第 1 次请求首页：不含新文章
# 第 2 次请求首页：包含新文章 ✅   ← SWR 语义，符合预期
```

所以问题不是"revalidateTag 完全坏了"，而是**它对 `getSettingsCached` 这个
条目不起作用**。

### 可能的方向（未验证）

1. `unstable_cache` 的 key 是 `["settings:all"]`（一个**不带参数的** cache key）。
   Next 可能会把"无参数"的缓存条目归到特殊路径，导致 tag 传播异常
2. Next 16 的 `revalidateTag(tag, profile)` 第二参数 `"max"` 的语义变化 ——
   文章那边能生效，所以不像
3. `getSettingsCached` 被 `SiteShell`（深层嵌套的服务端组件）调用，
   与直接在页面里调用可能有差异
4. `lib/settings.ts` 的**进程内缓存**（`TTL_MS = 10_000`）与 `unstable_cache`
   的 300s 叠加：可能是"进程内缓存失效了，但 unstable_cache 层没失效"，
   而 300s 到期后才会更新 —— **需要等 5 分钟验证一次**（本次没等那么久）

### 建议的排查顺序

1. **先等 5 分钟**再请求一次。如果变了 → 说明只是 `unstable_cache` 的
   `revalidate: 300` 在起作用，`revalidateTag` 没穿透进去
2. 给 `getSettingsCached` 的 cache key 加上参数（比如 `["settings:all", "v1"]`），
   看是否影响 tag 传播
3. 试 `revalidateTag(TAGS.stats)` **不带** `"max"` 参数（或换 `"default"`）
4. 若都不行，最粗暴但可靠的做法：把 `getSettingsCached` 改成**不用
   `unstable_cache`**，只靠 `lib/settings.ts` 的 10s 进程内缓存 ——
   设置是低频读、低频写的配置，10s 延迟完全可以接受

### 影响范围

- 后台改站名/简介/备案号后，前端最长要等 **5 分钟**（`unstable_cache` 的 TTL）
  才更新
- 用户不会看到错误内容，只是"改了没立刻生效"，容易误以为保存失败
- **不影响数据正确性**，不影响任何写操作

### 为什么现在不修

- 属于**缓存层**的机制问题，牵涉 `unstable_cache` / `revalidateTag` 的
  Next 内部行为，排查成本不低
- 当前所有改版工作（A/B/C/D 阶段）都优先，这个问题的实际影响是"延迟生效"，
  不阻塞任何功能
- 用户决定：等所有工作完成后再单独处理

### 修好后要补的测试

- 改 settings → 请求首页 → 断言新站名出现（**不轮询、不等待**，直接断言）
- 该测试现在**不能写**，因为会红 —— 这正是把它记成待办而不是"假装通过"的原因

---

## 2. `--fx-line-ink` 零引用（后台样式）

**记录时间**：2026-11-01（阶段 C-1 时发现）
**状态**：🟢 未修复，暂不处理
**优先级**：🟢 低（死代码，无功能影响）

### 现象

`app/admin/admin.css` 里 `--fx-line-ink` 定义了 **3 次**（`:root`、暗色块、
系统偏好暗色块），但全项目 `var(--fx-line-ink)` 引用 **0 处**。

```bash
grep -rn "fx-line-ink" app/ components/ lib/
# app/admin/admin.css:37   --fx-line-ink: rgba(32, 35, 31, 0.14);
# app/admin/admin.css:139  --fx-line-ink: rgba(237, 234, 226, 0.16);
# app/admin/admin.css:184  --fx-line-ink: rgba(237, 234, 226, 0.16);
```

### 为什么现在不修

C-1 只负责 `globals.css` 里的 58 个死 token；后台 `admin.css` 的样式治理
不在阶段 C 范围（路线图 C-1 的「涉及文件」只写了 `app/globals.css`）。

已在 `tests/design-tokens.test.ts` 的 `ALLOWED_UNREFERENCED` 白名单里
登记这一条（附注释说明），避免测试长期红着。

### 修法

确认无引用后删掉这 3 行。约 1 分钟。

---

## 3. 阶段 C 的 `globals.css` 行数未下降（已确认不改）

**记录时间**：2026-11-01（阶段 C 收尾）
**状态**：✅ **已决策：保持现状，不改**
**优先级**：—（不是问题）

### 现象

路线图 C.1 写着「完成后 `globals.css` 行数应下降（删死代码）而不是上升」，
实际从 2193 涨到 2373（+180 行）。

### 分任务归因

| 任务 | 净变化 | 说明 |
|---|---|---|
| C-1 删死 token | **−82** | 58 个零引用 token 确实删了 |
| C-2 暗色单源 | **+84** | 47 个 `--dark-*` 定义 + 两处 47 行映射 |
| C-5 内联→类 | **+81** | 13 处 JSX 内联变成 11 个 CSS 类 |
| C-7 刻度令牌 | **+49** | 10 个 token + 注释 |
| C-6 清理重复 | **+13** | 删重复定义，但补了说明注释 |
| C-3 / C-8 | +35 | |

其中**注释行 +89**（从 276 到 365），代码行 +84。

### 用户决策（2026-11-01）

**「R2 我认为是合理决策，不改」**

理由（记录用户原话与我的理解）：

- 「行数下降」的本意是**删死代码**，这一条已达成（58 个 token 归零，−82 行）
- 上涨来自**新增的可维护性投资**：暗色单源、语义类、设计令牌、解释性注释
- 若真要减行数，机会在于把老规则里的字面量做**全量令牌替换**（`border-radius:
  10px` ×14、8 档 transition 时长等），但那是高风险改动，路线图明确说本阶段不做
- 用"行数"当质量的代理指标本身是可疑的 —— 注释多的 CSS 更贵，但更安全

**因此不再把这一条当作待办。** 保留在此仅为记录决策，避免以后有人翻出
路线图那句话又困惑一次。

---

## 4. 前端内联样式还剩 2 处（有意保留）

**记录时间**：2026-11-01（阶段 C-5）
**状态**：✅ **已决策：保持现状，不改**
**优先级**：—（不是问题）

### 现象

`components/ArticleView.tsx:77` 与 `components/PostCard.tsx:39` 各有 1 处
`style={{ color: col.fg, background: col.bg }}`。

### 为什么保留

`categoryColor()` 返回的 `fg`/`bg` 是**运行时数据驱动**的（7 个分类，颜色
来自数据）。改成 class 需要：

- 渲染期动态生成 CSS（要注入 `<style>` 标签，有 CSP 与性能顾虑），或
- 用 7 个静态类（把颜色绑死在代码里，以后加分类要改代码）

Q5 默认方案选择保留内联。`tests/inline-styles.test.ts` 有断言守着"只能剩这
两处且必须是分类色"，防止有人往里加别的内联样式。

---

## 附：本文件的维护约定

- **新增条目**：写明现象、复现步骤、已排除的可能、影响范围、为什么现在不修
- **修好后**：不要只删条目 —— 先在对应的测试文件里加一条会红的断言，
  修完让它变绿，然后再删掉这里的记录
- **已决策「不改」的条目**：保留在文件里（标 ✅），因为**决策本身是信息** ——
  否则下一个人会重新提出同一个问题
