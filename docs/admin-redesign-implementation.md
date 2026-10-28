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

| 字段                    | 约束与用途                                                      |
| ----------------------- | --------------------------------------------------------------- |
| post_id                 | 主键；NOT NULL；references posts ON DELETE CASCADE              |
| client_draft_id         | 客户端 UUID；UNIQUE；与 post_id 绑定                            |
| owner_user_id           | 创建者；用于草稿归属校验和诊断                                  |
| base_revision           | 草稿基于的 posts.revision                                       |
| draft_revision          | 从 1 开始，每次成功变更递增                                     |
| snapshot_json           | 服务端规范化后的完整快照                                        |
| snapshot_hash           | 服务端计算的 SHA-256                                            |
| created_at / updated_at | UTC ISO 时间                                                    |
| updated_by              | 最近保存者；references users ON DELETE SET NULL，删用户不删草稿 |

### 3.3 post_revisions

| 字段               | 约束与用途                                                 |
| ------------------ | ---------------------------------------------------------- |
| id                 | 主键                                                       |
| post_id            | NOT NULL；references posts ON DELETE CASCADE               |
| revision           | 与 posts 发布后的 revision 对应；UNIQUE(post_id, revision) |
| snapshot_json      | 不可变完整快照                                             |
| snapshot_hash      | 快照身份                                                   |
| reason             | `baseline` 或 `publish`；恢复历史本身不插入                |
| publish_request_id | 发布幂等标识；baseline 为 NULL；非空时全局唯一             |
| created_by         | 操作者                                                     |
| created_at         | 实际写入时间；baseline 不伪造原发布时间                    |

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

| 方法   | 路径                                 | 职责                                                           |
| ------ | ------------------------------------ | -------------------------------------------------------------- |
| GET    | /api/admin/posts/:id/draft           | 返回草稿身份与快照；无草稿时明确返回 null 和当前 post revision |
| PUT    | /api/admin/drafts/:clientDraftId     | 新文章首次保存及同身份重试                                     |
| PUT    | /api/admin/posts/:id/draft           | 已有/新壳文章的完整快照保存                                    |
| DELETE | /api/admin/posts/:id/draft           | 带版本校验地放弃服务端草稿                                     |
| POST   | /api/admin/posts/:id/draft/rebase    | 用户确认后替换完整快照并更新基线                               |
| POST   | /api/admin/posts/:id/publish         | 发布当前服务端草稿                                             |
| POST   | /api/admin/posts/:id/restore-version | 用历史快照替换当前草稿                                         |
| PATCH  | /api/admin/posts/:id                 | 明确的元数据补丁，不再全字段覆盖                               |

旧 POST/PATCH 路由在迁移期只能委托上述服务，不能形成另一套数据语义。

### 6.1.1 编辑器调用矩阵

| 场景             | 调用顺序                                                                     |
| ---------------- | ---------------------------------------------------------------------------- |
| 新建且尚未保存   | 本地生成 clientDraftId，只写本地，不请求服务端                               |
| 新文章首次保存   | PUT /api/admin/drafts/:clientDraftId → 返回 postId 与 DraftIdentity          |
| 新文章首次保存后 | 当前会话绑定 postId，后续 PUT /posts/:id/draft                               |
| 打开已有文章     | 取得 posts 当前版本并 GET /posts/:id/draft；有草稿加载草稿，无草稿加载 posts |
| 旧文章首次建草稿 | expectedDraftRevision=0，并携带打开时的 expectedPostRevision                 |
| 首次保存超时     | 重试同一 clientDraftId；相同快照幂等返回，不同快照走正常版本校验             |
| 发布             | POST /posts/:id/publish，正文取服务端当前草稿                                |
| 恢复历史         | POST /posts/:id/restore-version，成功后继续编辑草稿                          |
| 放弃服务端草稿   | 带版本校验 DELETE /posts/:id/draft                                           |

新文章首次保存超时且尚未取得 postId 时，不得改走另一个新建接口。

### 6.1.2 鉴权与 step-up

所有端点必须 requireAdmin。发布与编辑沿用现有规则，破坏性删除保留二次验证，不给高频草稿操作增加 TOTP：

| 操作                           | step-up                        |
| ------------------------------ | ------------------------------ |
| 读取、保存、rebase 草稿        | 不需要                         |
| 删除服务端草稿                 | 不需要；有版本保护且可重新编辑 |
| 发布、取消发布                 | 不需要                         |
| 恢复历史到草稿                 | 不需要；须显式确认和双版本校验 |
| 单篇/批量软删除                | 需要                           |
| 单篇彻底删除                   | 需要                           |
| 批量发布、取消发布、恢复回收站 | 不需要，保持当前行为           |

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

| 操作      | 有当前草稿时                                     | 无草稿时                               |
| --------- | ------------------------------------------------ | -------------------------------------- |
| publish   | 跳过该条，HAS_UNPUBLISHED_DRAFT；不隐式选择快照  | 按逐项 expectedRevision 发布当前 posts |
| unpublish | 允许，保留草稿，revision+1；再次保存触发基线冲突 | 允许，revision+1                       |
| delete    | 允许软删并保留草稿，revision+1；再次保存 410     | 同样处理                               |
| restore   | 允许，revision+1；恢复后保存仍需基线校验         | 同样处理                               |
| purge     | 不可逆硬删，级联草稿/历史                        | 同样处理                               |

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

| 结果                                                                    | 处理                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| postId/clientDraftId/baseRevision/hash 匹配，draftRevision 为预期成功值 | already-saved                                                                  |
| hash 相同且 draftRevision 更大                                          | 当前值已同步，但不能清除更新的本地编辑                                         |
| posts 基线已变化                                                        | BASE_REVISION_CONFLICT                                                         |
| hash 不同且 draftRevision 更大                                          | DRAFT_REVISION_CONFLICT                                                        |
| 服务端身份仍等于 preIdentity，只是与本次发送内容不同                    | 本次未落库，可使用原请求身份有界重试                                           |
| draftRevision 未变，但服务端 hash 已不同于 preIdentity                  | `INCONSISTENT_STATE`，暂停该文自动保存，重新读取并显式核对，禁止旧版本直接重试 |
| GET 失败或身份无法确认                                                  | 保持 unknown，不清草稿、不盲目覆盖                                             |

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

四组任务导航，主操作“写文章”常驻。**以下是 02 实施后的实际分组**（与初版设计的差异见本节末说明）：

1. 工作：概览、内容（`/admin`，即文章/页面/说说的统一列表）。
2. 内容：评论、回收站。
3. 资源：媒体、外链、日志。
4. 系统：设置（站点 / 账号安全 / 图片存储）。

概览只放可行动信息：未发布草稿、最近编辑、待审评论、回收站提醒。不做装饰性访问量大屏。

**相对初版设计的三处调整（实施中确认，均为有意为之，不是遗漏）**：

| 初版设计                       | 实际实现                          | 理由                                                                                                 |
| ------------------------------ | --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 工作：概览、最近编辑、待办     | 工作：概览、内容                  | “最近编辑”“待办”已在概览页内作为区块呈现，再单列导航项等于同一信息两个入口                            |
| 资源：…、存储、…               | 存储并入 系统 → 设置              | 配置类事务集中一处；`/admin/storage` 以 308 跳转到 `/admin/settings/storage`，不留 404（02-5 决策）    |
| 系统：站点设置、安全、登录设备 | 系统：设置（内含三个子页）        | 三块的保存语义不同（见 02-5），作为子页区分，不占用顶层导航项                                          |

概览页初版曾计划放“内容构成”比例条与“存储异常”，实施后**均未落地**：比例条不改变任何决定却占用首屏最贵位置（02-1 返工删除）；存储异常改为在 `/admin/media` 与 `/admin/settings/storage` 就地呈现，概览不重复告警。`/admin/overview` 现有测试断言 `.kpi-card` 数量为 0，防止这两类元素回归。

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

| 交付                     | 落点                                                    | 验证方式                                                                                                          |
| ------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 独立临时数据库 fixture   | `tests/helpers/isolated-db.ts`                          | `assertIsolatedDataDir()` 拒绝 `data`；断言 `dbPath()===隔离路径`；跑完整套测试后 `data/blog.db` mtime 不变       |
| 长期行为测试             | `tests/posts-api.test.ts`                               | 鉴权 401、草稿不可公开（直读/公开路由/搜索/RSS/首页）、软删+恢复、发布状态、正文逐字节不变、slug 冲突 409         |
| 缺陷 pin（只记录不固化） | `tests/posts-api.test.ts` 的 4 条 `KNOWN-DEFECT`        | trim 改写正文、`cover:null` 清不掉、全字段 PATCH 静默清空 categories/tags、别名单写不在事务内（触发器取证后残留） |
| 独立应用上下文           | `tests/helpers/next-server.mjs`                         | 真进程 + 临时库 + 空闲端口；启动前清空 Next 缓存目录并断言其不存在                                                |
| 缓存预热/验证辅助        | `tests/helpers/public-cache.mjs`                        | `warmPublicCache` / `searchProbe`（no-store 直查）/ `waitForFresh`                                                |
| 浏览器双页测试基础       | `tests/helpers/browser.mjs` + `tests/browser-split.mjs` | 同 context 两 page 共享 storage；不同 context 的 storage 与 cookie 完全隔离；匿名 context 落 `/admin/login`       |
| HTTP 集成测试            | `tests/next-integration.mjs`                            | 真实 Next 上断言 unstable_cache 真实性、revalidateTag 失效、RSS/搜索/sitemap 各自语义、308+Location、HTTP 鉴权    |
| CI 全链路                | `.github/workflows/ci.yml`                              | Node 24：typecheck → 测试 → FTS5 冒烟 → 构建 → test:next → test:browser                                           |

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

#### 浏览器测试的环境前置条件（验收时补充记录）

浏览器类测试（`test:browser` / `test:ui` / `test:dark` / `test:admin` / `test:content` /
`test:comments` / `test:media` / `test:settings`）依赖两个**与代码无关**的环境条件。
缺任何一个都会让整套测试红，而报错信息不指向真实原因：

1. **Chromium 的系统动态库**：`libnspr4`、`libnss3`、`libasound2`。
   缺失时报 `error while loading shared libraries: libnspr4.so`。
   CI 里由 `npx playwright install --with-deps` 覆盖。
2. **中文字体（CJK）**：缺字体时中文控件按 fallback 字体（DejaVu）测量，度量与真实
   字体不同。表现为 `tests/ui-kit.mjs` 的 tab 热区断言失败：`.ui-tab` 只设了
   `min-height: var(--tap)`，**宽度由文字撑开**，DejaVu 下"文章"两字算得
   **43.73px**，触发 `width < 44`；而日志里 `Math.round` 又显示成 44，
   于是报出"44×44 却小于 44"这种自相矛盾的信息，极难归因。

> 判定方法：`fc-match "sans-serif:lang=zh-cn"` 若返回 DejaVu 之类的非 CJK 字体，
> 即为此问题。装上 Noto CJK 后同一断言实测 54×44 通过。

**结论与处置（已实施，2026-10-27）**：这是测试的**环境前提未被写明**，不是代码缺陷。
已按"显式化"路线处理，三道防线：

1. **测试自检**：`tests/helpers/prereqs.mjs` 的 `assertCjkFonts()` 由
   `tests/helpers/browser.mjs` 的 `startBrowser()` 统一调用（8 个浏览器测试都走这一个入口）。
   缺字体时不再让断言算出 43.73px，而是直接抛出带安装命令的错误：
   `Ubuntu/Debian: sudo apt-get install -y fonts-noto-cjk`，并说明
   `fc-match "sans-serif:lang=zh-cn"` 应返回中文黑体。
   Chromium 缺系统库时同样把 `error while loading shared libraries: xxx`
   翻译成 `npx playwright install --with-deps chromium`。
2. **CI 安装字体**：`.github/workflows/ci.yml` 在 `playwright install` 之后新增
   "安装中文字体" 步骤（`fonts-noto-cjk`），并打印 `fc-list :lang=zh` 条目数与
   `fc-match` 结果，便于在日志里直接确认字体已生效。
3. **CI 禁止绕过**：`SKIP_FONT_CHECK=1` 在本地可临时跳过，但**在 CI 下会被拒绝并报错**
   —— 否则"跳过检查"等于让不稳定的断言继续算错，把防线自己拆掉。

验证记录（实测）：

- 用空的 `FONTCONFIG_FILE` 模拟无字体环境 → 报错为可执行的字体安装指引，
  不再是"44×44 却小于 44"；
- 同上环境加 `SKIP_FONT_CHECK=1` → 复现原始失败（`ui-tab` 宽 28–43.73px），
  证明这道断言确实依赖字体度量、该检查有存在必要；
- 正常环境 → `test:ui` / `test:browser` / `test:dark` 全绿，检查无误报；
- `CI=1 SKIP_FONT_CHECK=1` → 被拒绝。

README 的"跑浏览器测试的前置条件"一节同步写明这两项要求与判定方法。

### 阶段 01-A：纯追加设计基础（已完成，2026-10-27）

交付与落点：

| 交付                                       | 落点                                                                     | 说明                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 三层 token（基础色板 → 语义色 → 组件别名） | `app/globals.css` 末尾追加块                                             | **纯追加**：`git diff --numstat` 为 +327 / -0，未改任何既有值与既有规则 |
| 基础组件                                   | `components/ui/{Button,Field,Skeleton,Tabs,Toast,StatBar,DataTable}.tsx` | 全部复用既有 `.btn/.input/.data-*` 类名，渲染结果与旧页面一致           |
| 组件对照页                                 | `app/admin/dev/ui`（`page.tsx` 门禁 + `kit.tsx` fixture）                | 只复用真实组件；未登录走后台统一重定向，生产未启用时 404                |

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

| 文件               | 改动                                                                                |
| ------------------ | ----------------------------------------------------------------------------------- |
| `MediaGrid.tsx`    | `--ok-fg/--warn-fg` → `--ok/--warn`；去掉全部 hex fallback                          |
| `StoragePanel.tsx` | `toneStyle()` 与状态徽章的 `ok/err` 映射改 `--ok*/--danger*`；`err` 归一到 `danger` |
| `PostList.tsx`     | 复核：`#e5484d` 已在既有轮次改为 `.btn-danger`，无残留字面量                        |

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

### 阶段 02：逐页后台重构（已完成，2026-10-27；共 5 个小阶段）

每页一个提交；同一提交内迁移完该功能，不留两套实现。保存协议不变，回归全绿。

#### 02-1 左侧栏分组导航与概览页（已完成，2026-10-27，含一次返工）

**导航改为四组任务导航，「写文章」常驻**（方案 §9.1，实际分组如下）：

| 分组 | 项                     |
| ---- | ---------------------- |
| 工作 | 概览、内容             |
| 内容 | 评论、回收站           |
| 资源 | 媒体、外链、日志       |
| 系统 | 设置                   |

共 8 个导航项。注意与初版设计的差异：文章/页面/说说是**同一个列表页 `/admin`**（靠类型筛选区分），
不作为三个导航项；「存储」在 02-5 并入系统 → 设置，不占资源组的独立入口。
`/admin/overview` 是「工作」组的第一项，`/admin`（内容列表）紧随其后。

- **桌面是真正的左侧栏**（216px，纵向排列，四组标题常驻可见）。
  首次实施时这里被做成了顶部单行、分组标题只在抽屉里出现，却命名为
  "侧栏分组导航" —— 名不副实，已返工修正。
- 手机（≤820px）侧栏隐藏，改为顶栏 + 底部抽屉，每项 48dp；
  「写文章」在桌面位于侧栏顶部，手机移进抽屉顶部（整行）。
- 分组标题 `aria-hidden`：它只是视觉层次，不是导航项，不该进入读屏导航流。
- 现有 `active` key（`posts` 等）保持不变，避免为了导航改名去动一堆页面传参。

**新增 `/admin/overview`**：只放可行动信息 —— 未发布草稿、最近编辑、待审评论、
回收站。刻意不做装饰性访问量大屏：那类数字好看但不改变任何决定，
却占着首屏最贵的位置。空库时给"没有待处理事项"的解释与「写一篇」出口。

> **本节经历一次返工**（提交 `2cc163f`）。初版概览是统计面板：4 张 KPI 卡 +
> "内容构成"比例条 + 常驻的待审/回收站区块。验收时被否掉，理由不是"不好看"而是
> **它答的是"我有什么"，不是"我该做什么"**：
>
> - KPI 卡与"内容构成"比例条不改变任何决定；草稿积压应该直接把草稿列出来，
>   而不是用一条彩条暗示"有积压"。
> - 首屏改为 `continue-card`：有草稿是"接着上次的草稿"，没有就回到最近编辑，
>   两者都给一个明确的继续动作。
> - 待审评论/回收站改成**条件出现**的任务链接，为 0 时完全不占位。
>
> 因此文档早期描述的"KPI 全部可点""内容构成"已不存在。现在测试断言
> `.kpi-card` 数量为 **0**，是防止这两类元素回归的守卫，不再验证"KPI 可点"。

**为什么没有把内容列表搬到新 URL**：`/admin` 作为内容列表被 23 处引用
（含登录后跳转、前台"进后台"、PostList 的"回到内容列表"），改路由属于
无收益的连带改动，且会让既有书签失效。分组导航解决了"找不到入口"的真问题，
URL 保持不变。
（口径：`app/` + `components/` + `lib/` 内指向内容列表的引用，含 `/admin` 与
`/admin?...` 两种写法，合计 23。迁移期核对可用
`git grep -n "/admin" HEAD -- app components lib` 再逐条判读。）

验证（`tests/admin-nav-overview.mjs`，8 项）：`/admin/overview` 可渲染、
**桌面存在可见侧栏且位于内容左侧**（216px）、侧栏四组标题常驻可见 + 8 个导航项
（存储已并入设置）、写文章常驻侧栏、概览以"继续工作"优先且无 KPI/比例条/前台壳、
手机侧栏隐藏/顶栏出现/抽屉四组且热区 ≥48 无横向溢出、概览空状态有解释与出口、
有数据时概览正确呈现草稿与计数。

首次实施时该测试断言的是"顶栏 9 项"，跟着错误实现一起通过了 ——
测试断言错了对象，就不会发现名不副实。现在第一条断言直接锁"侧栏可见 + 在左侧"，
把这类问题变成测试能抓住的东西。

#### 02-2 内容列表（已完成，2026-10-27，含一次返工）

- **状态筛选改为分段链接**（与评论页同一套 `.seg-tabs`）：原先是两个 `<select>`
  加一次「筛选」提交，点三下才能看到草稿。现在一次点击直达、URL 可分享。
- **ARIA 语义分开**：状态是"切换当前视图" → 用 `aria-current`，且**不挂 `aria-selected`**
  （方案 §9.3 明确禁止把它挂到普通链接/按钮上 —— 那会让读屏念"选项卡"，
  但界面上没有对应面板）。测试同时断言 `aria-selected` 为 null。
- **计数与筛选联动**：状态分段计数会带上当前 type 条件，否则"草稿 7"
  点进去只看到 2 条，非常困惑。
- **删掉底部重复的「待审核评论」整块**：它与 `/admin/comments` 做同一件事，
  后台不该有两个地方处理同一动作（迟早出现"这边处理了那边没刷新"）。
  改为一行入口直达待审筛选。
- 行内样式收进类名：`.content-toolbar` / `.list-head` / `.list-pager`。

> **本节经历一次返工**（提交 `4628783`），推翻了初版的两处做法，请勿按初版描述施工：
>
> 1. **类型筛选从 `aria-pressed` 按钮组降级为 `<select>`**。初版是四个
>    `aria-pressed` 按钮（`.type-filter`），实测在 375px 下与状态分段构成
>    "两排横向滚动条互相打架"。现在是一个 `<select>` 与搜索并排、走 GET 表单提交，
>    URL 仍可分享、与 `status` 组合保留。**所以 `.type-filter` 相关 CSS 已成为未使用的死代码**，
>    且测试中不再有 `aria-pressed` 断言 —— 早期文档写的"类型筛选用 `aria-pressed` 按钮组"
>    与"验证 6 项含 `aria-pressed`"均已作废。
> 2. **删掉 KPI 行**：KPI 与分段筛选表达的是同一维度（全部/已发布/草稿），
>    两处并存等于同一件事两个入口。工具条里重复的「回收站」按钮也一并去掉，
>    回收站只留侧栏入口。
>
> 另外**批量操作条改为按需出现**：发布/转草稿/移入回收站从常驻改为选中后出现，
> 未选择时只显示"全选 · N 条内容"元信息行，手机端不再为它付出一屏。

顺带修掉一个**同源的隐性缺陷**：StoragePanel 一直写着 `className="card"`，
但 `.card` **从未定义**，且没有行内 border/background 兜底 ——
这个面板渲染出来是一块没有边框、没有卡片底的裸内容，与旁边用 `Card` 组件的
区块明显不齐。已补 `.card`（取值与 ui.tsx 的 Card 一致），并新增
`tests/design-tokens.test.ts` 的第三条断言：静态 `className` 用到的类必须有对应样式。
（前台 `.prev` / `.brand-avatar` 也缺样式，但不在后台重构范围，已在测试里登记豁免
而不是让测试长期红着 —— 长期红的测试等于没有测试。）
注意这条断言只覆盖**静态 `className`**，所以它抓不到 `.type-filter` 这类
"CSS 还在、JSX 已删"的反向死代码。

验证（`tests/admin-content-list.mjs`，**5 项**）：无重复筛选/无前台壳/未选无批量条、
状态筛选为链接且无 `aria-selected` 且计数与结果一致、类型与搜索可与 status 组合、
批量条选中后出现取消后消失、375px 下首条内容 450px 内可见且搜索/类型仍可用无溢出。

> 项数从早期文档写的"6 项"更正为 **5 项**：早期清单里的"类型筛选 `aria-pressed`"
> 和"筛选热区达标"两条，在返工后已分别改为 `<select>` 与并入移动端断言，
> 不再作为独立断言存在。测试里的 PASS 输出实际是 5 条。

#### 02-3 评论管理（已完成，2026-10-27）

- **修掉空状态没有出口**：原来 `actions` 只在"筛选后为空"时给链接，
  **一条评论都没有时是 `undefined`** —— 用户看到一段说明却无处可去，
  违反 B 端门禁 14。现在两种空态都给出口。
- 评论卡片行内样式收进 `.comment-item` / `-head` / `-quote` / `-body`，
  四层（元信息/引文/正文/操作）有固定垂直节奏，长列表扫读对齐稳定。
- **修掉脏 URL**：分页原用字符串拼接 `"?status=" + status + "&page="`，
  status 为空时会生成 `?status=&page=2`。改用 `URLSearchParams` 统一构造。
- 评论正文加 `white-space: pre-wrap`（保留用户换行）+ `overflow-wrap: anywhere`
  （超长无空格串必须能断，否则 375px 横向溢出 —— 评论是用户输入，这条对应真实数据）。

保留不动：`CommentActions` 的三按钮语义 —— 通过与垃圾都是次级按钮、不替审核人
做决定，只有删除是危险色并要求确认。那是既有 B 端门禁的正确实现。

验证（`tests/admin-comments.mjs`，5 项）：无评论时空状态有出口、分段计数与
筛选一致、链接无空参数、400 字符无空格串不撑破 375px、审核动作重构后仍可用。

#### 02-4 媒体库（已完成，2026-10-27）

媒体页是这轮最"看起来没事、实际不能用"的一页。四条都是真实缺陷：

1. **页面硬编码 `LIMIT 120`，而 API 早就支持 `q/limit/offset`**。
   第 121 张图开始既看不见也删不掉，界面上还没有任何一句说明。
   现在筛选（全部/七牛/本机/未引用）、搜索、分页全部落到 URL 上，可分享可回退。
2. **扫描结果被截断却不说**。API 用 `slice(0, 200)` 回传，同时给出
   `orphanCount` / `missingCount` 两个**总数**；页面只读数组，于是"孤儿 300 个"
   时只列 200 条且当成了全部。现在按总数显示，并明确写"仅列前 N 个"。
3. **裂图与孤儿混在一行文案里**。`missing`（库里有、存储里没有）是真正会让
   文章掉图的问题，和"存储里有、库里没有"的可清理孤儿完全不是一回事。
   现在裂图单独成块、用危险色左条、列出具体路径并给出两条处理方向。
4. **"未引用"筛选此前根本不存在**，而它是最常用的清理入口。现在用
   `NOT EXISTS (... content LIKE '%' || m.path || '%')` 判定，被引用的图不出现在
   该筛选里。

版式与可达性（不是"调观感"）：

- 缩略图原来一律 `height:110px; object-fit:cover` —— **竖图被裁掉大半**，
  等于看不到自己传的是什么。现在按数据库里的真实 `width/height` 给
  `aspect-ratio`，缺宽高才退回 4:3；上限 260px 防止超长竖图撑破网格节奏。
- 每个 tile 原有约 12 个行内魔法数字，收进 `.media-*` 系列类名。
- 复制/删除按钮补 `aria-label`（"复制「x.png」的 Markdown 引用"），
  删除禁用时 title 写明"仍被 N 篇文章引用" —— 原来只说"不能删除"，
  不说为什么、也不说还有几处引用。
- 手机上操作按钮热区 46dp（与侧栏同一 44dp 标准）。

验证（`tests/admin-media.mjs`，11 项）：55 条数据分页两页都可达且总数正确、
存储位置筛选口径正确（七牛 40 / 本机 15）、搜索按文件名命中、
「未引用」排除被引用项（54 条，`q0.png` 不在其中）、筛选无结果时空状态有出口、
被引用图的删除按钮禁用且 title 说明原因、竖图按 800×1200 真实比例预览
（实测容器 187×260）、375px 无溢出且操作热区 46dp、裂图单独成块并列出路径、
暗色下 49/49 徽标跟随主题变色且对比度 ≥ 3。

**本轮测试自身踩的坑（记录，避免再犯）**：第一版暗色断言用了
"背景相对亮度 > 0.5 即失败"，把 `--ok-bg` 的 `rgba(111,214,166,.12)` 判成亮块 ——
`parseColor` 读成不透明的 `rgb(111,214,166)`，亮度 0.62。这与 01-B 那次
"底层半透明时按白底兜底算出 1.84:1 假结论"是同一类错误：**先看颜色字符串的
不透明度语义，再谈亮度**。改判据后仍不达标，因为取样顺序错了：上一次断言
（截图对比）已经把 `data-theme` 留在了 dark，所谓"light 值"其实是 dark 值，
于是 49 个徽标"一个都没变色"。补上显式回 light + 关过渡后才成立。

回滚：`app/admin/media/page.tsx`、`components/admin/MediaGrid.tsx`、
`globals.css` 的媒体块、`tests/admin-media.mjs` 四处可独立 revert，
不涉及 API 与数据。

#### 02-5 设置拆页 / 外链 / 操作日志（已完成，2026-10-27）

**设置拆成三页，理由不是"太长"而是"保存语义不同"**：

| 页面 | 地址 | 语义 |
| --- | --- | --- |
| 站点 | `/admin/settings` | 一堆字段 + 一个保存键，改的是前台可见文案 |
| 账号安全 | `/admin/settings/security` | 每个动作即时生效、要验证码、部分要确认弹窗 |
| 图片存储 | `/admin/settings/storage` | 七牛 AK/SK，保存后新上传才生效，且要先测连接 |

三块原本平铺在海报式单页里，最长的那块（账号安全）把另两块推到很远，
而它们的失败后果完全不同 —— 平铺最容易让人以为"保存设置"能一把改完。

**旧地址 `/admin/storage` 用 308 永久跳转**到新位置，不留 404：
这个地址可能已被收藏，"图片存储"也确实还在，只是换了归类。
导航里「存储」项同时移除 —— 同一件事有两个入口，最终一定出现
"这边改了那边没同步"的认知。

**修掉的四个真缺陷**：

1. **站点表单里还留着「友链（每行 名称|链接）」文本框，而前台一处都不读它。**
   友链早在 2026-10-23 就改成独立 `friend_links` 表 + `/admin/links` 管理，
   前台渲染只读表。留着这一格等于让人填一个**永远不生效**的输入框 ——
   填完提示保存成功，前台什么都没变。现在移除输入框，改成说明 + 去外链管理的出口
   （`settings.friendLinks` 字段与 KEY_MAP 保留，避免旧数据与 RSS 读取路径断裂）。
2. **站点表单保存没有任何反馈闭环**：改完不知道哪些还没存。现在顶栏常驻
   "有 N 处未保存的改动"、保存成功后变"已保存 · 时间"，无改动时保存按钮禁用。
   刻意不做离开拦截 —— 后台误弹 confirm 比丢一次可重填的编辑更烦。
3. **外链表单保存前零校验**：名称/链接为空也能点；URL 只接受 http/https
   （`isSafeUrl` 早就有，前台渲染前也过滤），但表单不说，填个 `javascript:`
   会保存成功、前台静默不显示 —— 用户看到的是"我加了外链但侧栏没有"。
   现在提交前拦住，并说明"前台会过滤，所以保存了也不会显示"。
   另外编辑态加了编辑条（正在改哪一条），显隐从 `opacity .5` 改为明确徽标
   「已显示 / 已隐藏」。
4. **日志的动作筛选是个自由输入框**（placeholder「如 post.delete」）—— 得先知道
   内部动作名才能筛，而这个名字只出现在结果行里。改成按前缀分组的链接
   （文章/评论/媒体/设置/存储/外链/登录/两步验证/会话），一次点击直达、URL 可分享。
   同时修掉 **分页链接丢掉 action 参数**的 bug：原来只拼 `page` 和 `q`，
   用动作筛选后再翻页会被静默丢弃，看起来像"翻页后数据变多了"。
   删除/失败/批量类动作给危险色，"谁删了什么"扫一眼就能筛出。

**顺带修掉一个构建级问题**：`LinksManager` 是 `"use client"` 组件，
引 `@/lib/friend-links` 会把 `./db` → `better-sqlite3` → `node:fs` 拉进浏览器包，
`next build` 直接报 `Module not found: Can't resolve 'fs'`。
类型与 `isSafeUrl`/`KIND_LABEL` 抽到 `lib/friend-links-shared.ts`（零依赖），
`lib/friend-links.ts` 保留 re-export，既有调用方不用改。

验证（`tests/admin-settings.mjs`，8 项）：三个设置页各自 active 子标签正确、
`/admin/storage` 返回 308 且 Location 指向新地址、站点表单 dirty 才可保存且保存后
显示时间、友链文本框已不存在且表单里有"去外链管理"出口、外链表单在**发请求前**
拦住空名称与 `javascript:` 链接（并断言 request 数确实为 0）、合法外链可保存且
显隐状态有徽标、日志分组筛选为链接且翻页保留 `group`、375px 三页均无溢出
（外链操作热区 44dp）。

**本轮测试修正（值得记）**：

- 「保存后应有 1 条外链」错了 —— 迁移 0011 会预置一条常驻「开往」（表为空才插），
  基数是 1。断言改成"比之前多 1 条"，而不是写死总数。
- 媒体测试原本直接插 55 条 media 记录，但**图片路径在磁盘上不存在**，
  页面渲染的 `<img>` 永远加载失败，Playwright `networkidle` 等不到，实测 30s 超时。
  裂图是"扫描结果要报的问题"，不该出现在初始数据里 —— 现在先写真实文件再插库。
  （顺带说明：这类超时**不是**页面变慢，而是断言对象和数据形态不匹配。）

回滚：三页拆分可用 308 跳转反向还原；外链/日志/站点三处的组件改动互不依赖，
可分别 revert。数据、API 与保存协议全程未改。

#### 阶段 02 收尾结论

02-1～02-5 完成后的实际覆盖面：导航与概览、内容列表、评论、媒体、外链、日志、
设置（站点/账号安全/图片存储）。**视觉与信息架构层面已全部落地；数据协议层
（草稿、快照、批量发布、自动保存、EditorV2）一行未动，全部在阶段 03。**

这一点必须说清楚：现在后台里能改的是文章正文与元数据的**当前值**，
还没有"草稿—发布"两态、"版本历史"、"发布前确认将替换哪一版线上内容"。
这些是阶段 03 的内容，不属于 02。

> 说明：阶段 02 的"逐页后台重构"已**全部完成**，不再有剩余版式工作。
> （早期此处曾写"只剩外链、日志、设置三处版式工作"，那三处已由 02-5 交付，
> 该备注已作废。）数据侧的草稿/快照/批量发布仍在阶段 03，尚未开始。

### 阶段 03.1：数据协议与旧编辑器适配（已完成，2026-10-28）

- 0012、快照规范化、严格审计、统一写入、草稿/发布/恢复/rebase 接口。
- 基线快照、发布幂等、逐项批量版本、脚本写入改造。
- 旧编辑器增加薄数据适配层：能读草稿、手动存草稿、发布；新旧 UI 共用它。
- 此时可不开自动保存，但手动草稿与发布隔离必须完整可用。

#### 交付与落点

| 交付                 | 落点                                          | 说明                                                                 |
| -------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| 快照规范化与哈希     | `lib/snapshot.ts`                             | 同步纯函数；`canonicalize()` 固定字段序、保留数组序、不 trim、不丢 null |
| 迁移 0012            | `lib/migrations.ts` 的 `0012_revision_drafts_history` | `posts.revision`、`post_drafts`、`post_revisions`、baseline 快照 |
| 严格审计             | `lib/audit.ts` 的 `logAuditStrict(db, input)`  | 收当前事务的同一 db 句柄、不吞异常；吞异常的 `logAudit` 保留作诊断     |
| 统一写入核心         | `lib/post-writes.ts`                          | 草稿/发布/恢复/rebase/元数据补丁/软删恢复，全部事务内                  |
| 路由公用件           | `lib/admin-route.ts`                          | WriteError→HTTP(带 code)、actor 提取、版本必填校验                     |
| 草稿接口             | `app/api/admin/posts/[id]/draft/route.ts`（+`/rebase`） | GET/PUT/DELETE + rebase                                    |
| 新文章首次保存       | `app/api/admin/drafts/[clientDraftId]/route.ts` | PUT 建壳+挂草稿（幂等）；GET 供超时后自查                             |
| 发布与结果核对       | `app/api/admin/posts/[id]/publish[-result]/route.ts` | 幂等发布 + `?requestId=` 核对                                  |
| 恢复历史             | `app/api/admin/posts/[id]/restore-version/route.ts` | POST 恢复为草稿；GET 版本列表                                  |
| 元数据 PATCH         | `app/api/admin/posts/[id]/route.ts`           | 三态补丁 + `expectedRevision` 原子更新                                |
| 逐项批量             | `app/api/admin/posts/bulk/route.ts`           | `items:[{id,expectedRevision}]`，逐项结果                            |
| 客户端适配层         | `lib/draft-client.ts`                         | 协议适配与错误分类（不碰 UI）                                         |
| 编辑器改造           | `components/admin/Editor.tsx`                 | 存草稿走草稿接口、发布走 publish；打开时加载服务端草稿                |
| 列表/概览显示草稿标题 | `app/admin/page.tsx`、`app/admin/overview/page.tsx` | 壳的 `posts.title` 为空，标题须取自草稿快照（§4.2）           |

#### 关键实现决定（都有明确理由，不要改）

1. **快照哈希与保存内容必须同源**：`canonicalize()` 返回的字符串**就是**入库的
   `snapshot_json`，`snapshot_hash = sha256(同一字符串)`。任何"顺手清理"都会让哈希口径
   与真实内容漂移，而那种偏差往往在 10 次自动保存之后才暴露。
2. **客户端 hash 只核对、不采信**：不一致直接 400 `CLIENT_HASH_MISMATCH`。
3. **`expectedRevision` 没有默认值**。曾经想把"删除时缺版本"默认成当前版本，但那等于
   留了一个隐式跳过并发检查的后门 —— 列表页刷新后可能删掉别人刚改过的文章。
   现在缺版本一律 400 `REVISION_REQUIRED`。
4. **发布幂等核对在"有没有草稿"之前**。发布成功后草稿会被删除，若先检查草稿，
   同一 `publishRequestId` 的重试会得到 `PUBLISH_REQUIRES_DRAFT`，客户端会把
   "其实已成功"误判为失败。
5. **新建 = 建壳 + 挂草稿（+ 需要时发布）**，`status:"published"` 也走同一条通路，
   不另写一条 INSERT —— 否则就是方案 §6.1 禁止的"第二套语义"。
6. **批量 publish 对有草稿的条目跳过**（`HAS_UNPUBLISHED_DRAFT`），不隐式选快照。

#### 阶段 00 遗留的 4 个缺陷已全部修复（pin 转为正向契约）

`tests/posts-api.test.ts` 的 4 条 `KNOWN-DEFECT`（todo 标记）按原约定改写为正向断言，
`npm test` 的 `todo` 从 4 归 **0**：

| 原缺陷                        | 现状                                                        |
| ----------------------------- | ----------------------------------------------------------- |
| trim 改写正文首尾空白         | 草稿快照与发布结果均逐字节保留（`pin#1 转正向`）             |
| `cover:null` 清不掉（COALESCE）| 三态语义，显式 null 真正清除（`pin#2 转正向`）               |
| PATCH 全字段覆盖              | 只改传入字段，未传的保留（`pin#3 转正向`）                   |
| slug 别名写入不在事务内        | 别名与 posts 同事务，失败一起回滚（`pin#4 转正向`，触发器取证）|

#### 顺带修掉的一个真实脚本缺陷

`scripts/materialize-native-deps.mjs` 的 `forceRemove()` 对**目录**也执行
`chmod 0o666`，把执行位剥掉，目录变成 `drw-rw-rw-`，之后连 `readdirSync`/`rmdirSync`
都进不去。表现是**下一次 `next build` 报**
`EACCES: permission denied, unlink .../.next/standalone/node_modules/better-sqlite3/package.json`，
而报错完全指不回"是这个脚本把权限改坏的"。更麻烦的是 `scripts/package-standalone.mjs`
里还有一份**复制出来的同名函数**，同样错法 —— 同一函数写两遍必然这样漂移。

已修：目录用 `0o777`、文件用 `0o666`（语义不同，不能共用一个常量），
并删掉 `package-standalone.mjs` 的副本改为从共享模块导入。
验证方式：连续两次 `npm run build` 后 `find .next -type d ! -perm -u+x` 计数为 0。

#### 验证

- `npm test`：**172 项全过、0 失败、0 todo**（其中 `tests/migrations.test.ts` 新增 3 条
  覆盖 0012：约束/索引/外键、脏 JSON 降级与回收站不建基线、重复迁移不重复插基线）。
- `test:next`（真实 Next + 隔离库）：8/8 通过。
- 浏览器套件：`browser` 3 / `ui` 7 / `dark` 3 / `admin` 8 / `content` 5 / `comments` 5 /
  `media` 11 / `settings` 8，全部通过。
- `npm run build` 与 `npm run build:dist` 均成功。

退出：公开隔离四层测试、冲突、回滚、发布幂等、基线迁移、脚本冒烟全通过。

回滚：保留 expand 数据；可关闭自动保存，不能回到不懂草稿的旧数据访问方式。应用回滚前必须确认旧代码与新增数据兼容，并保留可恢复备份。

### 阶段 03.2：自动保存与本地恢复（已完成，2026-10-28）

- 单飞状态机、超时核对、发布 unknown 核对、本地键和恢复界面。
- 崩溃、断网、丢响应、重复新建、保存期间新输入、多标签测试。
- `AUTOSAVE_ENABLED=0` 只关闭自动请求，手动草稿仍可用。

#### 交付与落点

| 交付             | 落点                            | 说明                                                             |
| ---------------- | ------------------------------- | ---------------------------------------------------------------- |
| 状态机           | `lib/autosave.ts`               | 8 态；单飞、有界退避、冲突即停；定时器与传输层全部可注入          |
| 超时核对         | `lib/autosave.ts` 的 `classifyReconcile()` | 7 种判定，区分"没到服务端"与"服务端被绕过写入"          |
| 本地存储         | `lib/local-draft.ts`            | 本地键、配额失败、假草稿防护、`canClearLocal()`                   |
| 状态指示器       | `components/admin/SaveStatus.tsx` | 草稿状态与线上版本**分开显示**                                  |
| 冲突三方对比     | `components/admin/SaveStatus.tsx` | 线上 / 服务端草稿 / 本地，并列但不自动合并                       |
| 本地恢复提示     | `components/admin/SaveStatus.tsx` | 显示 savedAt，否则用户不知道该不该信它                           |
| 编辑器接入       | `components/admin/Editor.tsx`   | 状态机挂载、pagehide/visibilitychange flush、冲突动作             |
| 传输层翻译       | `lib/draft-client.ts`           | `autosaveOnce()` 把 HTTP 结果翻成状态机可消费的 outcome           |
| 单元测试         | `tests/autosave.test.ts`        | 26 项：状态转移、单飞、退避、核对 7 分支、本地键与清理             |
| 浏览器测试       | `tests/autosave-browser.mjs`    | 8 项：自动保存、断网、崩溃恢复、多标签、保存中输入、冲突、配额失败 |

#### 关键实现决定

1. **状态机不碰 DOM**。定时器与传输层从外部注入，所以单飞/退避/核对这些最容易
   出错的地方能在 Node 里用假时钟精确断言。放进 React 就只能靠 sleep 撞运气。
2. **`mark()` 必须传入"本次输入后的值"**。React 的 setState 是异步的，
   在 `mark()` 里读闭包会拿到上一次渲染的 content —— 表现为"保存成功但内容是旧的"，
   每次只差一次击键，像偶发延迟，极难归因。实测确实踩到：自动保存把上一个标题存了进去。
3. **加载服务端草稿时必须同时 `setIdentity()`**。只更新 `identityRef` 不同步引擎，
   引擎会以为还没有草稿（draftRevision=0），第一次自动保存就撞 409，
   表面上完全像一个"版本冲突"，看不出是漏了一步同步。
4. **`classifyReconcile()` 的判定顺序经过两轮修正**：
   - 基线冲突必须**最先**判：内容完全匹配但 posts 已变，也不能说"已保存可继续"；
   - "hash 等于发送前"必须判在"状态矛盾"**之前**：那是正常状态，不是矛盾。
   这两处顺序错了都会给出看似合理、实则危险的结论。
5. **新标签页要能找回未保存的新文章**。崩溃后重开，sessionStorage 身份已丢失，
   只按当前 clientDraftId 找就等于每次崩溃都恢复不了自己刚写的东西。
   因此新文章路径退回"扫描本地草稿，取未绑定 postId 的那份"。
6. **旧的 `DRAFT_KEY` 机制整段删除**。两套本地存储会互相打架（时间戳口径不同），
   症状是"偶尔恢复出旧内容"——那类 bug 最难查。

#### 又修掉一个 forceRemove 的坑（这次是符号链接）

上一轮修了"目录被 chmod 0o666 剥掉执行位"，但**没有覆盖符号链接**：
`lstat` 判定软链既不是目录，就走"文件"分支执行 `chmodSync(link, 0o666)` ——
而 chmod **会跟随链接**，把**目标真实目录**的权限改成 0666。
`next build` 在 `.next` 里建大量软链（`standalone/node_modules/better-sqlite3`
就常是链接），于是那个真实目录被改坏，此后任何 build/测试碰它就报
`EACCES: permission denied, unlink .../better-sqlite3/package.json`。

更难定位的是：**破坏发生在清理阶段，报错发生在下一次运行**，两者可能隔了几个小时
甚至换了人。这次是观察到"跑完测试权限就坏、跑 build 不会坏"才锁定到测试进程的清理路径。

修法：`forceRemove` 把**符号链接判定提到最前**，且只 `unlink` 链接本身。
验证：修完后 `npm run build` → 跑测试 → 再查权限，仍是 `drwxr-xr-x`
（修之前跑一次测试就变 `drw-rw-rw-`）。

#### 验证

- `npm test`：**198 项全过、0 失败、0 todo**（新增 26 项自动保存单测）。
- `test:autosave`：**8/8 通过**（自动保存写草稿且 posts 不变、双状态指示、
  断网保留本地完整快照、崩溃后重开可恢复且显示时间、两标签页互不覆盖、
  保存期间输入不被清、冲突三方对比、配额失败常驻警告）。
- `test:next`：8/8；其余浏览器套件 3/7/3/8/5/5/11/8 全过（合计 50 项，无回归）。
- `npm run build` 连续 4 次干净，`.next` 内无权限异常目录。

### 阶段 03.3：EditorV2 与版本体验（已完成，2026-10-28）

- 纯 UI flag；数据层不随 flag 改变。
- 版本对比、恢复为草稿、冲突/rebase、移动端布局。
- 四项退出门槛：复杂文章 diff 为空；双标签无静默覆盖；断网恢复不丢已保证内容；发布/slug 308/公开缓存正常。
- 达标后当次删除旧 UI，不保留两套编辑器。

#### 交付与落点

| 交付       | 落点                                  | 说明                                                       |
| ---------- | ------------------------------------- | ---------------------------------------------------------- |
| 行级 diff  | `lib/diff.ts`                         | 自实现 LCS（零新依赖）；按行比较、保留空行、超长截断        |
| 快照字段 diff | `lib/diff.ts` 的 `diffSnapshotFields` | 标题/slug/封面/分类/标签/评论开关，空值显示为 (空)          |
| 版本历史与对比 | `components/admin/VersionPanel.tsx`  | 列表 + 与当前对比 + 恢复为草稿                              |
| 对比接口   | `app/api/admin/posts/[id]/version-diff/route.ts` | 两份快照**同一次读取**返回，避免 A/B 错位        |
| UI flag    | `lib/editor-flag.ts`                  | 只决定渲染哪套界面，不参与任何数据读写决策                  |
| 单元测试   | `tests/diff.test.ts`                  | 13 项：空闲判定、空行语义、行号、复杂 Markdown、字段差异     |
| 门槛测试   | `tests/editor-v2-browser.mjs`         | 6 项：四项退出门槛 + 恢复语义 + 历史列表                    |

#### 关键实现决定

1. **按行比较而不是按字符**。Markdown 里一行就是一个语义单元（标题、列表项、
   代码块内一行）。字符级 diff 会把"改两个字"渲染成一片碎片高亮，反而看不清改了什么。
2. **diff 的两个版本必须同一次读取**。分两次请求，中间若又发布一版，用户看到的
   就是"旧版 A 对新版 C"却以为在看 A 对 B —— 这种错位在界面上完全看不出来。
3. **列表显示"发布/初始基线"而不是"第 N 版"**。`revision` 是行版本，元数据改一次
   也会涨，当发布序号会误导。
4. **恢复按钮写"恢复为草稿"**，并在面板顶部说明"恢复后仍需发布才会更新前台"。
   只说"恢复"会让人以为等于上线。
5. **`EDITOR_V2` 不碰数据层**。方案 §0 冻结边界明确这一点；一旦 flag 影响数据路径，
   就等于存在两套数据协议。

#### 一个按语义澄清而非改代码的断言

新建文章的历史里只有 `publish`，**没有 `baseline`** —— 这是对的：
baseline 的语义是"迁移时为**存量**文章补一条已知状态"（方案 §3.4），
那些文章线上内容早就存在、历史却从零开始。新建文章没有这段空白，
第一次发布就写了 `publish`，方案 §7.2 担心的"有发布无历史"并不存在。
若给新建文章也塞 baseline，反而会出现"一次发布、两条同内容记录"的噪声。
测试原本硬凑两条，已按上述语义改正并在断言处写明理由。

#### 四项退出门槛结果（全部实测通过）

| 门槛                     | 结果                                                              |
| ------------------------ | ----------------------------------------------------------------- |
| 复杂文章 diff 为空       | 通过：图片/iframe/表格/代码块/脚注/引用/列表全含，正文逐字节不变   |
| 双标签无静默覆盖         | 通过：后保存者进入冲突态，服务端草稿与版本号均未被改动             |
| 断网恢复不丢已保证内容   | 通过：断网内容进本地完整快照，恢复网络后服务端内容不会变空         |
| 发布/slug 308/公开缓存   | 通过：UI 发布后公开可见，改 slug 后旧地址 308（轮询过 SWR 语义）   |

#### 验证

- `npm test`：**211 项全过、0 失败、0 todo**（新增 13 项 diff 单测）。
- `test:editor`：**6/6 通过**；`test:next` 8/8；`test:autosave` 8/8；
  其余浏览器套件 3/7/3/8/5/5/11/8 全过（无回归）。
- `npm run build` 成功，`.next` 内无权限异常目录。

#### 关于「达标后删除旧 UI」

方案要求"达标后当次删除旧 UI，不保留两套编辑器"。实际情况需要如实说明：

- 本阶段的版本体验是在**同一个编辑器组件**内扩展的（版本面板、冲突对比、
  双状态指示器），**没有另建第二套编辑器**，因此不存在"两套 UI 并存"需要删除的情况。
- **但 `lib/editor-flag.ts` 目前是一个只读开关，没有对应的第二套渲染分支** ——
  也就是说 `EDITOR_V2=0` 现在并不会切回旧界面，它只是一个预留给"将来需要时"的判定入口。
  这一点必须写清楚，否则下一个人会以为回退开关真的能用。

下一步（阶段 04 或收尾）应当二选一：
1. 若确定不再需要回退：**删除 `lib/editor-flag.ts`**，避免留一个名不副实的开关；
2. 若需要保留回退能力：补上真正的旧渲染分支，并加测试证明切换后功能可用。

按方案"不留两套实现"的取向，推荐第 1 种。在做出决定前，这个文件的注释里也标明了它是临时物。

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

**当前进度（2026-10-28）**：阶段 00、01-A、01-B 已完成；
**阶段 02 全部完成**（02-1 导航与概览含一次返工、02-2 内容列表含一次返工、
02-3 评论管理、02-4 媒体库、02-5 设置拆页/外链/日志）；
**阶段 03.1 已完成**（migration 0012、快照规范化、严格审计、统一写入核心、
草稿/发布/恢复/rebase 接口、发布幂等与结果核对、逐项批量、旧编辑器薄适配层，
阶段 00 遗留的 4 个缺陷已全部转正向契约）；
**阶段 03.2 已完成**（自动保存状态机、超时核对、本地键与恢复界面、冲突三方对比，
崩溃/断网/多标签/保存中输入/配额失败均有浏览器测试覆盖）。
**阶段 03.3 已完成**（版本历史与行级对比、恢复为草稿入口、移动端布局；
四项退出门槛全部实测通过）。
下一步进入 **阶段 04：效率增强** —— 独立 `/api/admin/search`、命令面板
Ctrl/Cmd+K、Toast/Skeleton/批量结果条。注意阶段 04 不得反过来修改已冻结的数据协议。

**两项收尾待办已处理（2026-10-28）**：

1. **删除 `lib/editor-flag.ts`**。它当时是只读开关、没有第二套渲染分支，
   `EDITOR_V2=0` 并不会切回旧界面 —— 留着一个名不副实的开关比没有更危险。
   按方案"不留两套实现"的取向直接删除，全仓已无 `EDITOR_V2` 引用。
2. **拆分 `Editor.tsx`**：把自动保存编排抽到 `components/admin/useAutosave.ts`。
   理由不是"文件太长"，而是那部分有**四类互相牵制的状态**（草稿身份、状态机、
   本地存储、冲突处理），全都依赖"最新的编辑器内容"，而 React 闭包会让"最新"
   变成"上一次渲染"—— 混在 900 行组件里，任何改动都可能悄悄破坏其中一条
   （实测踩过两次，报错位置离真正原因很远）。抽出来后约束集中一处。
   `Editor.tsx` 927 → 793 行；hook 262 行。拆分后 `test:autosave` 8/8、
   `test:editor` 6/6 全部照旧通过，说明行为未变。

**当前可上线状态**：03.1～03.3 已完成，CI 全链路绿。阶段 04（效率增强）尚未开始，
不影响后台核心可用性。

### 00～02 验收结论（2026-10-27，全部本地实跑）

验收方式不是"读文档确认"，而是逐项实跑 + 变异验证：

| 项目                                                | 结果                                                            |
| --------------------------------------------------- | --------------------------------------------------------------- |
| `tsc --noEmit`                                      | 通过                                                            |
| `npm test`                                          | 156 项：152 通过、0 失败、4 todo（即阶段 00 的 KNOWN-DEFECT pin） |
| `npm run build`                                     | 成功                                                            |
| `test:next`（真实 Next + 隔离库）                   | 8/8 通过                                                        |
| `test:browser`                                      | 3/3 通过                                                        |
| `test:ui` / `test:dark`                             | 通过 / 4 项通过                                                 |
| `test:admin`/`content`/`comments`/`media`/`settings` | 8 / 5 / 5 / 11 / 8 项全过                                       |

**三项硬承诺已独立验证**（不是引用文档自述）：

1. **隔离 fixture 真实有效**：`assertIsolatedDataDir()` 确实拒绝 `data`；跑完整套测试后
   `data/blog.db` 的 mtime 未变。
2. **阶段 00 未改生产代码**：`git diff 54d765a~1 e23b4f7` 只触及 `tests/`、`docs/`、
   `ci.yml`、`.gitignore`、`package*.json`，`app/`、`lib/`、`components/` **零改动**。
3. **01-A 纯追加属实**：`git show --numstat 7c18248 -- app/globals.css` 精确为
   **+327 / -0**。

**防回归测试的变异验证**（文档声称"验证过能抓到原 bug"，实测确认）：
把 `var(--ok-bg)` 改回 `var(--ok-bg, #e7f7ee)` 的原写法后，`tests/design-tokens.test.ts`
立即失败并精确指认 `components/admin/StoragePanel.tsx -> --err-bg`，同时第二条断言
报出硬编码 hex 回退；还原后复归全绿。**这两道防线是真实有效的。**

**验收中修正的文档偏差**（代码正确、文档过时，已按实现改写）：
布局与导航分组（§9.1、02-1）、概览页已从统计面板改为"继续工作"（02-1 返工）、
类型筛选已从 `aria-pressed` 按钮组改为 `<select>`（02-2 返工，`.type-filter` 已成死代码）、
`admin-content-list.mjs` 项数由 6 更正为 5。另新增"浏览器测试的环境前置条件"一节记录
系统库与 CJK 字体依赖（见阶段 00 小节）。

**浏览器测试环境前置条件已按 (a) 路线落地**：`tests/helpers/prereqs.mjs` 在
`startBrowser()` 里自检中文字体与 Chromium 系统库，缺了就报"该装什么"；
CI 新增 `fonts-noto-cjk` 安装步骤；`SKIP_FONT_CHECK=1` 在 CI 下被拒绝；
README 补充"跑浏览器测试的前置条件"。详见阶段 00 小节末尾。

本文档口径以此节与第 10 节为准；下面的历史条目仅保留记录用途，不再是"下一步"。

**历史记录（已过时，勿据此排期）**：阶段 00 完成时的原文曾写"下一步进入阶段 01-A"，
01-A、01-B 与 02-1～02-5 均已在该表述后完成。旧版 v5.2/v5.3 补丁说明同理作废。

03 施工严格按第 3～8 节执行；若实测发现协议缺口，先修订本文并记录原因，再改实现。
本文已合并最终审阅结论，不需要交叉查阅 v5.2/v5.3/v5.4 补丁。

阶段 00 遗留的 4 个已知缺陷（trim 改写正文、`cover:null` 无法清除、PATCH 全字段覆盖、
slug 别名写入不在事务内）**已在 03.1 全部修复**，对应 4 条 `KNOWN-DEFECT` pin 已改写为
正向契约测试，`npm test` 的 todo 归零。详见阶段 03.1 小节。
