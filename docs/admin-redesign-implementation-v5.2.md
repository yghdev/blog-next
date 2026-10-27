# 博客后台重构实施方案 v5.2

> 状态：实施基线；本文落盘不代表已经实施。
> 核实日期：2026-10-27。
> 范围：阶段 00～04 的设计、数据协议、测试、发布与回滚。
> 约束：本次只新增本文档，不修改业务代码、测试、数据库或配置。

## 0. 文档效力与冻结边界

本文合并 v3～v5.1 的有效决策，并修正审查中发现的协议缺口。实施时以本文为准；早期文档作为历史审计材料，不再作为施工依据。

### 已冻结

- 内容格式继续使用 Markdown 原文，不引入富文本 JSON。
- 本地恢复、服务端草稿、显式发布三层分离。
- `posts` 是公开内容的事实来源；草稿自动保存不得改变已发布内容。
- `posts.revision` 是行版本，`post_drafts.draft_revision` 是草稿版本；两者不互相替代。
- 发布历史不可变；恢复历史只生成草稿，不直接改线上内容。
- 所有内容写入都有版本语义，不提供通用跳过并发检查的开关。
- `EDITOR_V2` 只控制 UI；新旧界面共用同一数据访问层。
- 后台视觉采用任务导向导航、写作中心化、按需组件化，不追求固定组件数量。

### 可在实施中调整

- 自动保存 debounce 初值 1.5 秒、本地持久化节流初值 150ms。
- 命令面板防抖初值 300ms。
- 侧栏宽度、写作栏宽度和具体组件拆分，以真实页面走查为准。
- 工期仅作排序参考，阶段 03 以验收通过为准，不承诺固定日期。

## 1. 当前基线与问题定义

### 1.1 技术基线

- Next.js 16 App Router、React 19、better-sqlite3、SQLite WAL。
- 当前迁移到 `0011_friend_links`，`posts` 没有 revision、草稿表或历史表。
- 当前 `Editor.tsx` 是 Markdown textarea，已有本地草稿、预览、图片/视频插入和手动保存。
- 当前文章 PATCH 是全字段覆盖；封面用 `COALESCE`，无法显式清除。
- slug 别名写入和 posts 更新不在同一事务。
- 当前公开读取规则不同：文章数据缓存 TTL 300 秒；RSS 直读；公开搜索 no-store；sitemap revalidate 3600 秒。
- 旧 slug 当前通过 `permanentRedirect()` 返回 308，不是 301。
- 当前 CI 使用 Node 24；本地原生模块 ABI 异常不得被当作 CI 测试结论。

### 1.2 要解决的问题

1. 自动保存若直接写 posts，会把未发布修改暴露到前台。
2. 单飞请求只能防止当前页面自我覆盖，不能防止跨标签页、跨设备或脚本覆盖。
3. 响应丢失不代表服务端未提交，盲目重试或宣告失败都会误导用户。
4. revision 只能检测变化，不能提供历史恢复；恢复必须另有快照。
5. 新文章、旧文章首次建草稿、批量操作、恢复版本和运维脚本必须遵守同一套状态语义。
6. 后台组件、语义色和页面结构重复，需要在不改变数据行为的前提下逐步收敛。

### 1.3 非目标

- 不做多人协同编辑、实时 CRDT、字段级自动合并。
- 不做定时发布、复杂工作流、细粒度角色权限系统。
- 不重写前台、不更换数据库、不引入富文本编辑器。
- 不保存每次自动保存的完整历史；只保留当前草稿和发布/基线历史。
- 不承诺任意崩溃零丢失；明确本地持久化窗口和存储失败状态。

## 2. 总体架构

```text
浏览器内存快照
  ├─ 150ms 节流 + pagehide/visibility flush → localStorage（恢复防线）
  └─ 单飞、1.5s debounce → post_drafts（服务端当前草稿）
                              │
                              │ 显式发布，事务、双版本校验
                              ▼
                       posts + post_revisions
                              │
                              └─ 事务提交后失效公开缓存
```

核心不变量：

1. 已存在文章的草稿保存只写 `post_drafts`，不得改 `posts` 任意字段。
2. 新文章第一次服务端保存可创建 `posts(status='draft')` 壳记录，但不产生公开内容。
3. 只有显式发布、元数据操作、删除/恢复或受控运维写操作可以改 posts。
4. 草稿发布时必须满足 `draft.base_revision === expectedPostRevision === posts.revision`。
5. 恢复历史只替换当前草稿；发布恢复后的草稿时才追加新历史。
6. 数据提交、发布历史和强制审计原子完成；缓存失效在事务外，可重试。

## 3. 数据模型与迁移 0012

以下字段是逻辑模型，最终 DDL 按项目迁移风格实现；不得省略约束、外键和索引。

### 3.1 posts

新增：

```sql
revision INTEGER NOT NULL DEFAULT 1
```

已有行默认 revision=1。revision 是行版本，不是发布次数：新文章壳为 1，第一次发布通常为 2。

### 3.2 post_drafts

每篇文章最多一个当前服务端草稿：

| 字段 | 约束与用途 |
| --- | --- |
| post_id | 主键；NOT NULL；references posts ON DELETE CASCADE |
| client_draft_id | 客户端 UUID；UNIQUE；与 post_id 绑定 |
| owner_user_id | 创建者；用于草稿归属校验和诊断 |
| base_revision | 草稿基于的 posts.revision |
| draft_revision | 从 1 开始，每次成功变更递增 |
| snapshot_json | 服务端规范化后的完整快照 |
| snapshot_hash | 服务端计算的 SHA-256 |
| created_at / updated_at | UTC ISO 时间 |
| updated_by | 最近保存者，用户删除时按外键策略处理 |

### 3.3 post_revisions

| 字段 | 约束与用途 |
| --- | --- |
| id | 主键 |
| post_id | NOT NULL；references posts ON DELETE CASCADE |
| revision | 与 posts 发布后的 revision 对应；UNIQUE(post_id, revision) |
| snapshot_json | 不可变完整快照 |
| snapshot_hash | 快照身份 |
| reason | `baseline` 或 `publish`；恢复历史本身不插入 |
| publish_request_id | 发布幂等标识；baseline 为 NULL；非空时全局唯一 |
| created_by | 操作者 |
| created_at | 实际写入时间；baseline 不伪造原发布时间 |

历史列表按 id/created_at 展示，不能把 revision 当作连续发布序号。

### 3.4 基线快照

0012 为所有未删除的现有文章创建一条 `reason='baseline'` 快照。不得在 SQL 中直接对 categories/tags 调 `json()`：现有数据可能含脏 JSON，且 SQL 另写格式容易与哈希口径漂移。

迁移必须通过共享 TypeScript 函数执行：

```text
读取 posts 行
→ 安全解析 categories/tags，沿用既有降级规则
→ canonicalize()
→ 得到最终 snapshot_json
→ 对完全相同的字符串计算 snapshot_hash
→ INSERT OR IGNORE baseline
```

不修改 posts 正文、slug、状态或时间。回收站文章不创建基线。

### 3.5 保留与删除

- 对仍存在或仅软删除的文章，不自动清理发布历史。
- 彻底删除时，草稿、历史及已有级联数据一并永久删除。
- purge 确认框必须列出将删除的历史版本数、草稿和评论影响。
- `prune.mjs` 对超期回收站的硬删除遵守同样语义。

## 4. 快照、slug 与身份规范

### 4.1 完整快照

```ts
type Snapshot = {
  type: 'post' | 'page' | 'shuoshuo';
  title: string;
  slug: string;
  content: string;
  cover: string | null;
  categories: string[];
  tags: string[];
  comments_enabled: 0 | 1;
};
```

- categories/tags 保留顺序，不为了哈希而排序。
- title/content 不在哈希阶段暗中 trim；若产品要清理标题，先由校验层生成最终保存值。
- 哈希输入必须等于数据库实际保存的 snapshot_json。
- 服务端永远重新 canonicalize 并计算 hash；客户端 hash 仅用于核对，不一致返回 400，不能信任。
- 草稿 PUT 使用完整快照，必填字段缺失返回 400，避免“缺省”被不同接口解释成不同含义。
- 独立元数据 PATCH 才使用三态：字段缺省不改；cover:null 清除；cover:string 设置。

### 4.2 新文章壳与空白草稿

首次保存可能尚无标题，不能沿用“发布文章必须有标题”的规则来拒绝草稿。

- 壳记录：status=draft、published_at=NULL、revision=1、content/excerpt 为空。
- 壳 slug 使用服务端生成的唯一保留值，例如 `draft-<去连字符 UUID>`，不占用用户正式 slug。
- 草稿标题、正文和拟定 slug 保存在 snapshot 中；后台列表用草稿快照覆盖展示壳标题。
- 发布时才要求文章/页面标题合法、生成或确认正式 slug，并处理 slug 唯一性及别名。
- 说说不强制标题，沿用现有业务规则。
- 新文章壳创建后必须返回 postId；后续保存、发布均按 postId 进行。

### 4.3 草稿身份

```ts
type DraftIdentity = {
  postId: number;
  clientDraftId: string;
  baseRevision: number;
  draftRevision: number;
  snapshotHash: string;
};
```

URL postId、body clientDraftId、数据库绑定和当前用户归属必须一致。UUID 不可猜测不能代替鉴权。

## 5. 统一写入与发布事务

### 5.1 写入边界

- `lib/post-writes.ts` 收口在线 posts 写入；路由不得直接拼接 posts 写 SQL。
- 草稿、历史、快照 canonicalize 和严格审计使用共享库层函数。
- 所有元数据更新要求 expectedRevision，并以 `WHERE id=? AND revision=?` 原子更新。
- 无通用 `skipRevisionCheck`。
- 批量操作逐项传 `{id, expectedRevision}`，逐项返回 published/updated、skipped、conflicts、notFound。
- 静态扫描覆盖 INSERT/UPDATE/REPLACE/DELETE/db.exec 和多行 SQL，但不替代真实数据库测试。

### 5.2 严格审计

现有 `logAudit()` 吞异常的行为可继续用于非关键诊断，但发布、恢复历史等强制审计必须使用严格写入函数：

- 在业务事务内插入审计，失败则回滚整个业务事务。
- 审计只存摘要和身份，不复制完整正文。
- 发布幂等重试不重复写审计。
- 缓存失效在事务外；失败可重试，不回滚已提交数据。

### 5.3 发布事务

发布以服务端当前草稿为内容来源，不接受客户端在发布请求中另传一套正文。

```text
BEGIN IMMEDIATE
  1. 按 publishRequestId 查已有发布结果：
     - postId、操作者、请求内容身份一致 → 返回原结果
     - 标识被复用于其他文章/内容 → 409 IDEMPOTENCY_CONFLICT
  2. 读 posts，未找到返回 404，软删除返回 410 ARTICLE_GONE
  3. 读当前草稿；发布必须有草稿
  4. 校验 expectedPostRevision === posts.revision
  5. 校验 draft.base_revision === posts.revision
  6. 校验 expectedDraftRevision === draft.draft_revision
  7. 校验草稿快照可发布，确定正式 slug，检查 slug/alias 冲突
  8. slug 变化时写旧 slug 到 post_aliases
  9. UPDATE posts，计算 excerpt、状态和时间，revision 恰好 +1
 10. INSERT post_revisions，记录快照、hash、操作者、publishRequestId
 11. DELETE 当前 post_drafts
 12. 严格写入 post.publish 审计
COMMIT

事务外：invalidate 公开缓存；返回已提交结果
```

任一步失败，posts、aliases、revisions、draft 和强制审计一起回滚。事务提交后缓存失败或响应丢失不代表发布失败，客户端进入 unknown 并按 publishRequestId 核对。

### 5.4 发布结果核对

提供受管理员鉴权保护的结果查询，例如：

```text
GET /api/admin/posts/:id/publish-result?requestId=<uuid>
```

返回发布 revision、slug、snapshotHash 和结果状态。相同发布请求重试可以重复执行缓存失效，但不得重复更新 posts、追加历史或审计。

## 6. 草稿接口与状态转换

### 6.1 端点

| 方法 | 路径 | 职责 |
| --- | --- | --- |
| GET | /api/admin/posts/:id/draft | 返回草稿身份与快照；无草稿时明确返回 null 和当前 post revision |
| PUT | /api/admin/drafts/:clientDraftId | 新文章首次保存及同身份重试 |
| PUT | /api/admin/posts/:id/draft | 已有/新壳文章的完整快照保存 |
| DELETE | /api/admin/posts/:id/draft | 带版本校验地放弃服务端草稿 |
| POST | /api/admin/posts/:id/draft/rebase | 用户确认后替换完整快照并更新基线 |
| POST | /api/admin/posts/:id/publish | 发布当前服务端草稿 |
| POST | /api/admin/posts/:id/restore-version | 用历史快照替换当前草稿 |
| PATCH | /api/admin/posts/:id | 明确的元数据补丁，不再全字段覆盖 |

旧 POST/PATCH 路由在迁移期只能委托上述服务，不能形成另一套数据语义。

### 6.2 旧文章首次创建草稿

约定无草稿时 `expectedDraftRevision=0`，有草稿时 >=1。首次创建也必须传 `expectedPostRevision`，不得直接把当前 posts revision 当作新基线。

```text
BEGIN IMMEDIATE
  1. posts 必须存在且 deleted_at IS NULL
  2. expectedPostRevision 必须等于 posts.revision，否则 BASE_REVISION_CONFLICT
  3. 无草稿：
     expectedDraftRevision=0 → 插入 base_revision=当前版本、draft_revision=1
     expectedDraftRevision>0 → 409 DRAFT_NOT_FOUND
  4. 有草稿：
     expectedDraftRevision 必须匹配
     draft.base_revision 必须仍等于 posts.revision
     更新完整快照、hash，draft_revision+1
COMMIT
```

PRIMARY KEY(post_id) 防重复；并发下另一个会话不能因“无草稿”而覆盖已创建草稿。

### 6.3 新文章幂等创建与更新

`PUT /api/admin/drafts/:clientDraftId` 同样带完整快照、客户端 hash 和版本信息：

- 不存在：事务内创建壳和草稿，返回 postId 与 DraftIdentity。
- 已存在且身份、规范化快照一致：幂等返回，无版本递增。
- 已存在但快照不同：进入正常保存协议，必须提供 expectedDraftRevision 和 expectedPostRevision。
- 缺版本、版本不符、postId/clientDraftId 绑定不符或归属不符：409/403，不得静默成功。

### 6.4 恢复历史

请求带 `revision`、`expectedDraftRevision`、`expectedPostRevision`。事务内校验文章未删除、两个版本匹配、目标历史属于该文章，然后：

- 用历史完整快照替换当前草稿；无草稿则创建。
- base_revision 设为当前 posts.revision，不是历史 revision。
- draft_revision 新建为 1，更新则 +1；重算 hash。
- 不改 posts，不新增 post_revisions。
- `post.restore_version` 强制审计与草稿更新同事务。

### 6.5 rebase 与放弃

rebase 请求带 expectedDraftRevision、最新 expectedPostRevision、用户确认的完整快照和客户端 hash。服务端重算 hash、再次校验版本，只更新 base_revision、draft_revision、快照和 hash；不做字段级自动合并。

界面必须区分：

- 放弃本地未同步内容：仅清指定本地快照，不调用接口。
- 删除服务端草稿：带 expectedDraftRevision/expectedPostRevision 调 DELETE，成功后回到 posts 当前版本。

## 7. 批量、删除与运维规则

### 7.1 批量操作

| 操作 | 有当前草稿时 | 无草稿时 |
| --- | --- | --- |
| publish | 跳过该条，HAS_UNPUBLISHED_DRAFT；不隐式选择快照 | 按逐项 expectedRevision 发布当前 posts |
| unpublish | 允许，保留草稿，revision+1；再次保存触发基线冲突 | 允许，revision+1 |
| delete | 允许软删并保留草稿，revision+1；再次保存 410 | 同样处理 |
| restore | 允许，revision+1；恢复后保存仍需基线校验 | 同样处理 |
| purge | 不可逆硬删，级联草稿/历史 | 同样处理 |

每个成功项 revision 恰好 +1；跳过、冲突、不存在项完全不变。缓存只针对成功项失效。

### 7.2 运维脚本

- `prune.mjs`：唯一受控硬删除例外；只删超过回收站期限的行。公开内容此前已不可见，不要求每小时重启 Next。
- `rebuild.mjs`：复用可供脚本运行的共享写入核心，逐项版本递增、严格事务；不得以永久 allowlist 代替改造。
- `migrate-wp.mjs`：一次性导入器，检测到 posts 非空即拒绝。仅用于新库初始化；导入已发布内容时同步生成 baseline，不能留下“有发布无历史”的状态。
- TypeScript 共享模块的 Node 24 加载方式在 03.1 先做一个脚本冒烟验证，不假设 .mjs 可以直接解析 @/ 别名。

rebuild/migrate-wp 采用维护窗口：

```text
备份并验证备份 → 停止公开写入/停止应用 → 执行脚本
→ 数据与搜索索引检查 → 重启应用 → 公开面验证 → 解除维护窗口
```

第一版不新增“requireAdmin + 限本机”的缓存维护接口：脚本没有管理员 Cookie，代理后来源 IP 也不是脚本身份。独立脚本进程不能直接调用 Next revalidateTag。

## 8. 自动保存、超时核对与本地恢复

### 8.1 状态机

状态：idle、dirty、queued、saving、saved、conflict、unknown、failed。

- 输入立即更新内存快照和 localSnapshotId。
- 150ms 节流写 localStorage；1.5s debounce 后请求服务端。
- saving 单飞；期间新编辑只标 queued，不并发第二请求。
- 成功后更新 DraftIdentity；若有 queued，立即用最新身份保存新快照。
- 409 停止自动重试，保留本地快照，进入冲突界面。
- 4xx 校验错误不盲目重试；5xx 有界退避；网络超时进入 unknown。
- 401/403、冲突、失败和 unknown 均不得清本地恢复数据。

### 8.2 超时核对

以“本次发送快照 + 预期成功后的 draftRevision”为核对上下文，GET 当前草稿：

| 结果 | 处理 |
| --- | --- |
| postId/clientDraftId/baseRevision/hash 匹配，draftRevision 为预期成功值 | already-saved |
| hash 相同且 draftRevision 更大 | 当前值已同步，但不能清除更新的本地编辑 |
| posts 基线已变化 | BASE_REVISION_CONFLICT |
| hash 不同且 draftRevision 更大 | DRAFT_REVISION_CONFLICT |
| hash 不同且 draftRevision/baseRevision 均未变化 | 可确认本次未落库，使用原请求身份安全重试 |
| GET 失败或身份无法确认 | 保持 unknown，不清草稿、不盲目覆盖 |

发布超时不走草稿 GET，改走 publish-result；幂等重试处理已提交结果。

### 8.3 本地键与清理

```text
草稿：draft:<userId>:<clientDraftId>
映射：draft-post:<userId>:<postId> → clientDraftId
```

- 新标签页生成独立 UUID，并在 sessionStorage 保留该标签页的新文章身份，刷新不重新生成。
- 已有文章通过 postId 映射找到对应 clientDraftId；服务端绑定仍是最终依据。
- LocalDraft 保存 clientDraftId、postId、base/draft revision、snapshot、localSnapshotId、已确认 hash 和 savedAt。
- 仅在“服务端确认的快照身份 = 当前本地快照身份 + 没有更新编辑/queued”时清本地副本。
- 保存响应到达后又产生的输入不得被清理或误标 saved。

### 8.4 持久化边界

- visibilitychange:hidden 与 pagehide 同步 flush。
- beforeunload 只在确有未同步状态时提示，不承担保存职责。
- navigator.onLine 只作提示，真实请求结果决定在线状态。
- localStorage 配额/隐私模式失败显示常驻警告；不自动消失，不宣称本地恢复可用。
- 正常退出和切后台应可恢复；崩溃最多可能丢最后约 150ms，不承诺 kill -9 任意时刻零丢失。

## 9. 后台信息架构与视觉实施

### 9.1 导航与页面

四组任务导航，主操作“写文章”常驻：

1. 工作：概览、最近编辑、待办。
2. 内容：文章/页面/说说、评论、回收站。
3. 资源：媒体、外链、存储、日志。
4. 系统：站点设置、安全、登录设备。

概览只放可行动信息：未发布草稿、最近编辑、待审评论、存储异常、回收站提醒。不做装饰性访问量大屏。

### 9.2 编辑器

- 保持 Markdown 原文和现有上传、预览能力。
- 双状态：草稿保存时间/状态，与线上版本时间/状态分开。
- 桌面居中写作主栏，元数据侧栏可收起；移动端底部固定保存/发布。
- 发布确认展示标题、slug、公开状态及将替换的线上版本。
- 冲突提供三方差异：当前 posts、服务端草稿、本地快照；禁止自动 rebase。
- 历史恢复先进入草稿，再由用户发布。
- 复杂文章保存前后正文逐字节一致，不借重构规范化旧 Markdown。

### 9.3 Token 与组件

三层 token：基础色板 → 语义色 → 少量组件别名。现有 --text-p*、--ok*、--danger* 映射到语义层，不建平行体系；间距、圆角、字号按需追加，不改前台既有视觉值。

组件按重复度收敛：Button、Field/Input、DataTable、Tabs、Toast、Skeleton、StatBar，以及编辑器专用 SaveStatus/ConflictDialog/VersionCompare。已有 PageHeader/Card/Notice/Empty/Badge/Kpi/ConfirmDialog/BottomSheet 先复用，不为凑数重建。

对照页使用 `/admin/dev/ui`：复用真实组件，只有 fixture 布局；未登录沿用后台统一登录重定向，已登录但生产未启用时 404，不进导航。

筛选按钮用 aria-pressed；筛选链接可用 aria-current，不把 aria-selected 挂到普通按钮。URL 保留其他筛选，变化时重置分页。

## 10. 分阶段实施与提交边界

### 阶段 00：测试基线与基础设施

交付：

- 独立临时数据库 fixture，DATA_DIR 指向 tmp；禁止触碰开发库和线上库。
- 长期行为测试：鉴权、草稿不可公开、软删/恢复、发布状态、正文不变、旧 slug 308+Location。
- 当前缺陷只写 KNOWN-DEFECT 或 test.todo：cover 无法清除、全字段 PATCH、非事务别名等，不固化为未来契约。
- 独立应用上下文、缓存预热/验证辅助、浏览器双页测试基础。
- CI Node 24 跑 typecheck、测试、构建，记录真实结果。

退出：CI 全绿；fixture 隔离有测试证明；未改生产保存语义。

### 阶段 01-A：纯追加设计基础

- 追加 token 别名、按盘点新增基础组件、新增 /admin/dev/ui。
- 不替换现有页面，不迁移旧 class。
- 对照页覆盖空/加载/错误/禁用/长文本/双主题/窄屏。

回滚：删除新增文件和追加块，独立提交。

### 阶段 01-B：暗色缺陷独立修复

仅处理已确认的 PostList、MediaGrid、StoragePanel 颜色字面量与 token 映射，双主题走查，独立 revert。

### 阶段 02：逐页后台重构

- 侧栏与概览；内容列表；评论；媒体；外链/日志；设置拆页。
- 每页一个提交；同一提交内迁移完该功能，不留两套实现。
- 保存协议仍不变化；现有回归测试全绿。

### 阶段 03.1：数据协议与旧编辑器适配

- 0012、快照规范化、严格审计、统一写入、草稿/发布/恢复/rebase 接口。
- 基线快照、发布幂等、逐项批量版本、脚本写入改造。
- 旧编辑器增加薄数据适配层：能读草稿、手动存草稿、发布；新旧 UI 共用它。
- 此时可不开自动保存，但手动草稿与发布隔离必须完整可用。

退出：公开隔离四层测试、冲突、回滚、发布幂等、基线迁移、脚本冒烟全通过。

回滚：保留 expand 数据；可关闭自动保存，不能回到不懂草稿的旧数据访问方式。应用回滚前必须确认旧代码与新增数据兼容，并保留可恢复备份。

### 阶段 03.2：自动保存与本地恢复

- 单飞状态机、超时核对、发布 unknown 核对、本地键和恢复界面。
- 崩溃、断网、丢响应、重复新建、保存期间新输入、多标签测试。
- `AUTOSAVE_ENABLED=0` 只关闭自动请求，手动草稿仍可用。

### 阶段 03.3：EditorV2 与版本体验

- 纯 UI flag；数据层不随 flag 改变。
- 版本对比、恢复为草稿、冲突/rebase、移动端布局。
- 四项退出门槛：复杂文章 diff 为空；双标签无静默覆盖；断网恢复不丢已保证内容；发布/slug 308/公开缓存正常。
- 达标后当次删除旧 UI，不保留两套编辑器。

### 阶段 04：效率增强

- 独立 /api/admin/search，requireAdmin，含草稿/页面/说说、排除回收站、不返回正文。
- 命令面板 Ctrl/Cmd+K，搜索失败不影响导航与操作。
- Toast、Skeleton、批量结果条；不反过来修改已冻结的数据协议。

## 11. 验收矩阵

### 11.1 数据安全硬门槛

1. 已发布文章自动保存 10 次后，posts 全行逐字段不变。
2. 直接读取、公开 HTTP、主动失效缓存后均看不到草稿的标题/正文/slug/封面。
3. 新文章壳和草稿不出现在首页、RSS、搜索、公开文章路由；page/shuoshuo 同样覆盖。
4. 发布后 posts.revision 恰好 +1，新增一条不可变历史，草稿清理，强制审计恰好一条。
5. 恢复历史只改草稿；随后发布才追加历史，revision 不回退。
6. 无草稿首次保存使用旧 expectedPostRevision 时返回基线冲突，不自动 rebase。
7. 新文章同 clientDraftId 重试不重复创建；同 UUID 不同快照不会被静默丢弃。
8. 发布响应丢失后重试不重复发布/历史/审计，并能核对原结果。
9. 保存中追加输入不会被清掉；两个新建标签页本地草稿不互覆。
10. 封面可清除；完整快照缺字段被拒绝；服务端不信任客户端 hash。
11. slug 别名写入后故障导致 posts/aliases/revisions/draft/audit 全回滚。
12. 批量成功项 +1，跳过/冲突项不变；有草稿发布项被跳过。
13. unpublish 后保存为基线冲突；软删后保存 410；恢复后仍需显式 rebase。
14. 运维脚本遵守版本/基线规则，维护窗口后公开缓存与数据库一致。

### 11.2 公开隔离的缓存方法

- 隔离应用与临时数据库，先预热首页、文章、归档等缓存。
- 自动保存期间不主动清 posts 缓存；数据库与直读函数是最强断言。
- /api/search 是 no-store 直查，验证 NEW 无结果、旧标题有结果。
- RSS 直读；sitemap revalidate 3600 单独测，不作为正文泄露主探针。
- 主动 revalidateTag(TAGS.posts) 后页面仍为旧公开版本，证明不是缓存掩盖了数据库变化。

### 11.3 故障与浏览器测试

- 故障注入采用测试依赖注入或独立测试构建，不提供 HTTP 开关。
- 验收生产构建中不存在可启用的故障入口，不能仅凭 NODE_ENV 字符串宣称 tree-shake。
- 同 browser context 两 page 测 localStorage 隔离；不同 context 测独立会话/存储下的服务端冲突，两者不能互相替代。
- slug 当前验收为 308 和 Location；若未来改 301，单独立项改契约。
- 除两个 curl 外，必须有真实 SQLite 并发和 Playwright 场景。

### 11.4 静态扫描与例外

扫描 app/lib/scripts 的多行 SQL，至少覆盖 UPDATE、INSERT OR ...、REPLACE、DELETE、db.exec。

- 完成 03 后在线 posts 写入仅允许共享写入核心。
- migrations、测试 fixture、prune 有显式理由的例外。
- migrate-wp 只能保留一次性导入例外及非空库拒绝测试；rebuild 不得以永久例外绕过版本。
- 扫描是辅助，不能代替并发和公开面测试。

### 11.5 功能与体验

- 5 篇复杂文章（图片、iframe、表格、代码块）保存/发布前后正文 diff 为空。
- 本地媒体记录和文件存在；外链图片只做带超时的抽样 GET/Range，网络失败单独报告，不阻断正文保存。
- 登录、TOTP、恢复码完整；七牛错密钥必失败且 UI 不误报成功。
- 375px 可写文章、传图、审评论、改设置。
- 双主题无硬编码色泄漏；键盘可达、焦点可见；命令面板纯键盘可用。
- 每页有空/加载/错误三态。style={{}} 数量只作参考，不作验收门槛。

## 12. 发布、备份与回滚

### 发布前

- CI Node 24 全绿；本地 ABI 问题不代替 CI 结果。
- 备份 SQLite，并验证备份可打开、迁移前后文章数与关键哈希一致。
- 先在备份副本执行 0012，核对 baseline 数量、脏 JSON 降级和历史快照可读。
- 明确部署包不包含 data、草稿、测试和文档中的敏感数据。

### 发布顺序

1. 部署向后兼容的 expand schema 与新读取/写入代码。
2. 先验证手动草稿和发布隔离，再开自动保存。
3. 小范围开 EditorV2；观察冲突、unknown、存储失败和发布幂等日志。
4. 验收后删旧 UI；04 的增强可独立发布。

### 回滚原则

- 不回滚或 DROP 新表来“清理现场”；保留草稿和历史。
- UI 回滚只切 EDITOR_V2；数据访问层保持草稿感知。
- 自动保存可单独关闭，手动草稿和显式发布仍工作。
- 若必须回到旧应用版本，先评估它是否会忽略/覆盖草稿；必要时从已验证备份恢复，而不是假装 schema 向后兼容等于应用兼容。
- 运维脚本执行前必须维护窗口和备份；prune 的硬删除不可恢复。

## 13. 完成定义

只有同时满足以下条件，才称为后台重构完成：

- 数据安全硬门槛全绿，公开隔离不被缓存测试掩盖。
- 新文章、旧文章、恢复、rebase、批量、脚本、发布超时都有闭环。
- 强制审计与业务提交一致，幂等重试不重复副作用。
- 新旧 UI 不共用两套数据协议，旧 UI 最终删除。
- 双主题、键盘、375px 和复杂旧文章通过真实走查。
- 每个阶段可独立部署，回滚说明经过验证，而非只写在表格里。

## 14. 下一步

从阶段 00 开始，只建立测试基线与基础设施，不在该阶段实现新草稿模型。03 施工严格按第 3～8 节执行；若实测发现协议缺口，先修订本文并记录原因，再改实现。
