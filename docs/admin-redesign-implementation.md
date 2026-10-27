# 博客后台重构实施方案 v5.4（最终版）

> 状态：实施基线；本文落盘不代表已经实施。
> 核实日期：2026-10-27。
> 范围：阶段 00～04 的设计、数据协议、测试、发布与回滚。
> 约束：本次只新增本文档，不修改业务代码、测试、数据库或配置。

## 0. 文档效力与冻结边界

本文合并 v3～v5.4 的有效决策与全部审阅修订，是完整、自洽的最终实施基线。实施时以本文为准；早期版本只作为历史审计材料，不再作为施工依据。阶段 00 可先行，03.1 必须完整遵守第 3～8 节。

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
| updated_by | 最近保存者；references users ON DELETE SET NULL，删用户不删草稿 |

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

迁移必须通过共享 TypeScript 函数执行。`canonicalize()` 与 `hashSnapshot()` 必须是**同步纯函数**：不依赖 `await`、浏览器、请求上下文或 `next/*`，可被迁移、接口和运维脚本共同加载。

```text
读取 posts 行
→ 安全解析 categories/tags，沿用既有降级规则
→ canonicalize()
→ 得到最终 snapshot_json
→ 对完全相同的字符串计算 snapshot_hash
→ INSERT OR IGNORE baseline
```

不修改 posts 正文、slug、状态或时间。回收站文章不创建基线。任一文章的基线生成失败时，当前迁移事务整体回滚，`getDb()` 抛出错误并阻止应用启动；不接受部分文章有基线的启动状态。

基线测试必须构造含非法 JSON 的文章，断言迁移成功且按既定规则降级、每篇未删除文章恰有一条 baseline、`snapshot_hash === sha256(snapshot_json)`、posts 原行未改变。

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

现有 `logAudit()` 吞异常的行为可继续用于非关键诊断，但发布、恢复历史等强制审计必须使用严格写入函数 `logAuditStrict(db, input)`：

- 显式接收当前业务事务的同一个 `db` 句柄，不得调用基于 `getDb()` 单例且吞异常的 `logAudit()`。
- 函数内部不吞异常；在业务事务内插入审计，失败则异常冒泡并回滚整个业务事务。
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

### 6.1.1 编辑器调用矩阵

| 场景 | 调用顺序 |
| --- | --- |
| 新建且尚未保存 | 本地生成 clientDraftId，只写本地，不请求服务端 |
| 新文章首次保存 | PUT /api/admin/drafts/:clientDraftId → 返回 postId 与 DraftIdentity |
| 新文章首次保存后 | 当前会话绑定 postId，后续 PUT /posts/:id/draft |
| 打开已有文章 | 取得 posts 当前版本并 GET /posts/:id/draft；有草稿加载草稿，无草稿加载 posts |
| 旧文章首次建草稿 | expectedDraftRevision=0，并携带打开时的 expectedPostRevision |
| 首次保存超时 | 重试同一 clientDraftId；相同快照幂等返回，不同快照走正常版本校验 |
| 发布 | POST /posts/:id/publish，正文取服务端当前草稿 |
| 恢复历史 | POST /posts/:id/restore-version，成功后继续编辑草稿 |
| 放弃服务端草稿 | 带版本校验 DELETE /posts/:id/draft |

新文章首次保存超时且尚未取得 postId 时，不得改走另一个新建接口。

### 6.1.2 鉴权与 step-up

所有端点必须 requireAdmin。发布与编辑沿用现有规则，破坏性删除保留二次验证，不给高频草稿操作增加 TOTP：

| 操作 | step-up |
| --- | --- |
| 读取、保存、rebase 草稿 | 不需要 |
| 删除服务端草稿 | 不需要；有版本保护且可重新编辑 |
| 发布、取消发布 | 不需要 |
| 恢复历史到草稿 | 不需要；须显式确认和双版本校验 |
| 单篇/批量软删除 | 需要 |
| 单篇彻底删除 | 需要 |
| 批量发布、取消发布、恢复回收站 | 不需要，保持当前行为 |

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

批量 publish 对每个实际成功项使用独立事务：校验 expectedRevision、确认无草稿且当前确为 draft、读取 posts 完整快照、更新发布字段并 revision+1、插入 `reason=publish` 的 post_revisions（revision 为更新后的值，审计 meta 标记 origin=bulk）、严格写发布审计，再提交。已发布项跳过 ALREADY_PUBLISHED，不重复递增或写历史。各项独立提交，允许部分成功并逐项返回。

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
| 服务端身份仍等于 preIdentity，只是与本次发送内容不同 | 本次未落库，可使用原请求身份有界重试 |
| draftRevision 未变，但服务端 hash 已不同于 preIdentity | `INCONSISTENT_STATE`，暂停该文自动保存，重新读取并显式核对，禁止旧版本直接重试 |
| GET 失败或身份无法确认 | 保持 unknown，不清草稿、不盲目覆盖 |

保存前必须记录 preIdentity、sentSnapshotHash 和预期成功版本。正常“请求未到达服务端”与“hash 变了但 revision 未 bump”不得混淆。INCONSISTENT_STATE 记录告警、保留本地完整快照，不阻断查看/导出/其他文章，但必须重新读取、比较并显式 rebase 后才能继续保存。

所有保存冲突、失败和 unknown 都必须保留 sentSnapshot 供差异比较，并立即 flush 当前内存最新完整快照；不得用服务端回显覆盖请求期间的新输入。409 返回 submittedSnapshotHash 与 server 当前 postRevision/draftRevision/snapshotHash/snapshot，不强制回显整份 echoedSnapshot。

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
- 以真实 setItem 结果为准，不设跨浏览器的固定容量安全线，不自动删除其他未同步草稿。完整草稿写入失败时不得标记“本地已保存”；若保留上一份成功旧草稿，必须标明 savedAt，不能冒充最新内容。
- 禁止在正常草稿键中降级成只含摘要/hash 的“假草稿”。本地也失败时保留服务端自动保存，并提供 Markdown/JSON 导出；警告引导用户立即保存到服务端或导出备份。
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

对照页使用 `/admin/dev/ui`：复用真实组件，只有 fixture 布局；未登录沿用后台统一登录重定向，已登录但生产未启用时 404，不进导航、不索引。404 表示功能未开放，不承担隐藏路由存在的安全目标，proxy 不增加特殊分支。

筛选按钮用 aria-pressed；筛选链接可用 aria-current，不把 aria-selected 挂到普通按钮。URL 保留其他筛选，变化时重置分页。

## 10. 分阶段实施与提交边界

### 阶段 00：测试基线与基础设施（已完成，2026-10-27）

交付与落点（文件名即交付物，不再有"文档里写了但仓库里没有"的项）：

| 交付 | 落点 | 验证方式 |
| --- | --- | --- |
| 独立临时数据库 fixture | `tests/helpers/isolated-db.ts` | `assertIsolatedDataDir()` 拒绝 `data`；断言 `dbPath()===隔离路径`；跑完整套测试后 `data/blog.db` mtime 不变 |
| 长期行为测试 | `tests/posts-api.test.ts` | 鉴权 401、草稿不可公开（直读/公开路由/搜索/RSS/首页）、软删+恢复、发布状态、正文逐字节不变、slug 冲突 409 |
| 缺陷 pin（只记录不固化） | `tests/posts-api.test.ts` 的 4 条 `KNOWN-DEFECT` | trim 改写正文、`cover:null` 清不掉、全字段 PATCH 静默清空 categories/tags、别名单写不在事务内（触发器取证后残留） |
| 独立应用上下文 | `tests/helpers/next-server.mjs` | 真进程 + 临时库 + 空闲端口；启动前清空 Next 缓存目录并断言其不存在 |
| 缓存预热/验证辅助 | `tests/helpers/public-cache.mjs` | `warmPublicCache` / `searchProbe`（no-store 直查）/ `waitForFresh` |
| 浏览器双页测试基础 | `tests/helpers/browser.mjs` + `tests/browser-split.mjs` | 同 context 两 page 共享 storage；不同 context 的 storage 与 cookie 完全隔离；匿名 context 落 `/admin/login` |
| HTTP 集成测试 | `tests/next-integration.mjs` | 真实 Next 上断言 unstable_cache 真实性、revalidateTag 失效、RSS/搜索/sitemap 各自语义、308+Location、HTTP 鉴权 |
| CI 全链路 | `.github/workflows/ci.yml` | Node 24：typecheck → 测试 → FTS5 冒烟 → 构建 → test:next → test:browser |

阶段 00 期间确认并写进代码注释的三个真实坑（后续阶段不要再踩）：

1. **standalone 的 native 依赖是空壳**。Next 对 `serverExternalPackages` 只产 `package.json`
   空壳 + 指向空壳的软链，直接 `node .next/standalone/server.js` 必报
   `Cannot find module 'better-sqlite3-<hash>'`。实体化逻辑收敛在
   `scripts/materialize-native-deps.mjs`，由 `build:dist` 与集成测试**共用**，
   避免"能部署"和"能测试"两套判据漂移。
2. **`fs.rmSync` 在 Windows 上会跟进 junction**删除链接目标里的真实内容。对项目根
   `.next` 执行 `rmSync` 会把 `node_modules/better-sqlite3` 清空（验收中已实际发生两次）。
   凡可能含链接的目录一律用 `forceRemove()`（lstat 判定为链接即只 unlink 链接本身）。
3. **`revalidateTag(tag, "max")` 是 stale-while-revalidate**：失效后第一次请求仍返回旧缓存，
   第二次才刷新。测试必须轮询到位，不能断言"立刻变新值"，否则假失败；也不能反过来
   放宽成"等等看"，否则掩盖真问题。

退出（全部已实测）：CI 全链路绿灯；fixture 隔离有测试证明；未改生产保存语义
（`git status` 只触及 tests/、package.json、ci.yml、docs/ 与新增 scripts 辅助模块）。

### 阶段 01-A：纯追加设计基础（已完成，2026-10-27）

交付与落点：

| 交付 | 落点 | 说明 |
| --- | --- | --- |
| 三层 token（基础色板 → 语义色 → 组件别名） | `app/globals.css` 末尾追加块 | **纯追加**：`git diff --numstat` 为 +327 / -0，未改任何既有值与既有规则 |
| 基础组件 | `components/ui/{Button,Field,Skeleton,Tabs,Toast,StatBar,DataTable}.tsx` | 全部复用既有 `.btn/.input/.data-*` 类名，渲染结果与旧页面一致 |
| 组件对照页 | `app/admin/dev/ui`（`page.tsx` 门禁 + `kit.tsx` fixture） | 只复用真实组件；未登录走后台统一重定向，生产未启用时 404 |

刻度不是自定的：间距/圆角/字号取自 `app/` 与 `components/` 的实际用量统计
（间距高频 4/6/8/10/12/14/16/20/24，圆角 8/10/12/14/20，字号 .72~.95rem），
令牌只收录真实出现过的值 —— 多出来的刻度等于鼓励新代码写出没人用过的间距。

对照页覆盖空 / 加载 / 错误 / 禁用 / 长文本 / 双主题 / 窄屏，并由
`tests/ui-kit.mjs` 在真实浏览器里判定（不靠肉眼）：
- 未启用时**已登录也 404**；启用后正常渲染；不进导航；带 `noindex`
- 双主题确实切换 token 驱动色（`rgb(252,252,251) → rgb(26,26,25)`）
- 暗色对比度全部 ≥ 4.5:1（最小 5.21）
- 375px 无横向溢出（375/375），tab 与 toast 关闭键热区 ≥44

走查中修正的两个真实问题（都不是"调整观感"）：
1. `.ui-table-head` 原用 `--text-p4`，暗色卡片底上只有 3.57:1。列头是表格内容、
   读屏会朗读，属正文级文字，改用 `--text-p3`（5.21:1）。只改新组件取值，
   不动全局 `--text-p4`（那是既有视觉，属 02 范围）。
2. `.ui-tab` 未选中态原用 `--text-p3`，实测 1.89:1 不达标。tab 是可交互控件，
   其文字按 WCAG 1.4.3 属正文级，改用 `--text-p2`（9.46:1）。

配套的测量方法学（避免"改了就过"）：
- 对比度数学抽到 `tests/helpers/contrast.mjs`，并用 WCAG 官方值做单元测试
  （黑白 21:1、`#767676` 对白 4.54:1）。原因是同一页面两版手写公式分别算出
  2.77 与 1.89，尺子不准时任何结论都不可信。
- 浏览器侧只取原始颜色字符串，且**先关掉 transition 再取色**：切换主题瞬间
  读到的是插值中间态（实测抓到 `rgba(90,90,90,.71)`），会得出假结论且每次不同。

回滚：删除新增文件与 `globals.css` 末尾追加块即可，无既有文件改动需回退。

### 阶段 01-B：暗色缺陷独立修复（已完成，2026-10-27）

**根因不是"配色不好看"，而是 token 名字写错、fallback 静默接管。**

MediaGrid 与 StoragePanel 的状态徽章写的是：

```
background: var(--ok-bg, #e7f7ee);  color: var(--ok-fg, #1a7f4b);
border: 1px solid var(--ok-bd, #b8e6cc);
```

其中 `--ok-fg`、`--warn-fg`、`--err-bg`、`--err-fg`、`--ok-bd`、`--err-bd`
**全部从未定义**（规范里叫 `--ok` / `--ok-bg` / `--ok-border`，错误态用
`--danger` 一族，没有 `err` 这一层）。于是每一次渲染都走 fallback ——
硬编码的浅色主题色值：浅绿底 `#e7f7ee` 配深绿字 `#1a7f4b`。
代码读起来像"已经用了 token、应该主题安全"，实际在暗色下是一整块亮斑。

这与 docs/design-system.md 记录的历史坑（`--lift-1/--lift-2/--surface-2`
曾被引用但从未定义）是**同一类问题**，说明"引用了未定义 token"会反复发生。

改动（仅这三处颜色，行为与布局零改动）：

| 文件 | 改动 |
| --- | --- |
| `MediaGrid.tsx` | `--ok-fg/--warn-fg` → `--ok/--warn`；去掉全部 hex fallback |
| `StoragePanel.tsx` | `toneStyle()` 与状态徽章的 `ok/err` 映射改 `--ok*/--danger*`；`err` 归一到 `danger` |
| `PostList.tsx` | 复核：`#e5484d` 已在既有轮次改为 `.btn-danger`，无残留字面量 |

防回归（两道，都验证过"能抓到原 bug"）：

1. `tests/design-tokens.test.ts`（Node 层，快）
   - 全仓扫描 `var(--x)`，凡引用了但从未定义的令牌直接失败。
     把原写法放回去会得到 `MediaGrid.tsx -> --ok-fg` 这样的精确指认。
   - 单独盯住"带 hex fallback 的 `var()`"，禁止状态徽章再退回硬编码色值。
   - 豁免：`--mx/--my` 是运行时由 JS 注入的坐标变量，不是设计令牌。
2. `tests/dark-mode.mjs`（真实浏览器，慢但可信）
   - 切主题后这些元素**颜色必须变化**（证明 token 真的生效，而非恰好同色）
   - 暗色下不得出现浅底亮块（背景相对亮度 > 0.5 即失败）
   - 文字在各自背景上对比度 ≥ 3（避免"修成暗底暗字"的反向错误）
   - `.btn-danger` 不得回到 `rgb(229,72,77)` 实色

测量方法学（本轮又修了一次同类错误）：`contrastFromLayers` 现在**拒绝**
最底层背景半透明的输入并直接抛错。原先它在底层半透明时默默按白底兜底，
于是暗色页面上把 `rgba(224,176,98,.12)` 当成"叠在白纸上"，算出 1.84:1 的
假结论，差点让人去改本来没问题的样式。宁可测试失败，也不要一个猜测的基准。

回滚：这三个文件的颜色改动可独立 revert，不涉及结构、逻辑与数据。

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

### 11.0 测试分层

- Node 测试负责 SQLite 行级断言、lib/posts.ts 直读、草稿/发布/恢复/rebase/幂等、迁移、真实事务回滚、批量版本与静态扫描；不在 loader 中模拟 next/cache。
- 真实 Next 集成测试负责 unstable_cache、缓存预热、revalidateTag、RSS/搜索/sitemap 各自语义、308、HTTP 鉴权。缓存失效断言只能在这一层执行，需要真实起服务。
- 浏览器测试负责本地草稿隔离、跨会话冲突、断网/响应丢失、保存中继续输入、首次保存超时和发布丢响应。
- 测试控制钩子只存在于测试运行环境，不提供公开维护接口。


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

- 优先在测试直接调用事务服务时做依赖注入，生产代码不提供故障环境变量或 HTTP 开关。
- 正向回滚测试是唯一安全硬门槛：证明故障生效于 alias 写入后、COMMIT 前，并断言 posts/aliases/revisions/draft/audit 全回滚。
- 若用独立测试构建，预定义唯一测试标记；CI 扫描生产产物中的标记、测试模块和测试路由。这些只作辅助检查，不宣称证明绝对不存在。
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
- 回滚到 03 之后旧 UI：安全，仍使用统一草稿数据适配层。
- 回滚到 03 之前不懂草稿的历史版本：先进入维护状态、停止新编辑并备份，再检查 post_drafts。无草稿时可评估回滚并保留新增表；有草稿时只能保持新数据适配层、逐篇发布/明确丢弃后再回滚，或从明确时间点备份恢复并接受其后数据损失。
- 禁止有草稿时直接回到只读 posts 的旧编辑器并继续写作；不提供危险的一键清空全部草稿。
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

阶段 00 已完成并通过实测验收（见第 10 节阶段 00 的交付表与三条已确认的坑）。下一步进入
阶段 01-A：纯追加设计基础，仍然不改数据协议、不替换现有页面。

03 施工严格按第 3～8 节执行；若实测发现协议缺口，先修订本文并记录原因，再改实现。
本文已合并最终审阅结论，不需要交叉查阅 v5.2/v5.3/v5.4 补丁。

阶段 00 遗留、需在 03 一并解决的已知缺陷（已在测试里 pin 住，不会悄悄漂移）：
trim 改写正文首尾空白、`cover:null` 无法清除、PATCH 全字段覆盖、slug 别名写入不在事务内。
