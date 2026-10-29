---
name: deploy-blog
description: 把这个博客（Next.js 16 standalone + SQLite + systemd + nginx）安全发布到生产：预检、全量校验、构建打包、上传核对、原子部署、版本与静态资产比对、隔离副本冒烟、必要回滚。用于"上线/发布/部署/发版/推上去"这类请求，也用于判断线上跑的到底是哪次提交、以及部署失败后的回滚。
whenToUse: 用户说"上线""发布""部署""发版""推到服务器""更新线上"；或线上行为与本地不一致、需要核对版本、需要回滚时。
---

# 博客上线流程

这是一个**单人自建博客**的生产发布流程。目标不是"把文件传上去"，而是
**在用户察觉之前，把"看起来成功"和"真的成功"分开**。

历史上这套流程栽过的每一种跟头，都在下面的硬约束里对应一条：

| 事故 | 根因 | 现在的防线 |
| --- | --- | --- |
| 部署显示成功，线上还是旧代码 | systemd 的 WorkingDirectory 不是 `current` 软链 | `deploy.sh` 前置校验，不一致直接拒绝 |
| 起来就 500 | standalone 里的 better-sqlite3 是空壳软链 | `deploy.sh` 从 `shared/native` 拷入并 `require` 自检 |
| 页面没样式 | tar 层级错了 / 静态资源没进产物 | `tar -C dist .` + `verify-assets` 逐字节比 CSS |
| 找不到 server.js | 归档多套了一层 `dist/` | release.sh 解包前就断言 `./server.js` 存在 |
| 版本无法追溯 | 工作区脏着构建，产物打 `(dirty)` | release.sh 拒绝非干净工作区 |
| 半截文件 | scp 被截断 | 上传后两端比 sha256 |
| healthz 全绿但功能坏了 | healthz 只证明进程活着 | 隔离副本冒烟（真实数据 + 真实产物） |

## 零、先读这三条铁律

1. **绝不"直接在线上点一遍"当验收。** 冒烟会新建草稿、真发布、再转草稿，
   在生产库上做等于往审计日志和版本历史里写测试数据。用
   `scripts/smoke-remote.sh`：复制生产库到 /tmp、起临时端口、跑完就删。
2. **永不手工 `cp` 文件进 `/opt/blog`。** 它是「软链 + releases + shared」的容器，
   手工复制不会生效，只会制造"改了但没变"的幻觉。
3. **数据目录永远指 `/var/lib/blog`。** 任何临时实例、脚本、调试进程，`DATA_DIR`
   都必须指向副本；把临时实例指到生产库是**不可逆**的事故。

## 一、一条命令的正常路径

```bash
# 1) 确认工作已提交并推送（产物要能对应一个 commit）
git status --short && git push origin master

# 2) 构建 + 校验 + 打包 + 上传，停在"可以部署了"
bash .dsh/skills/deploy-blog/scripts/release.sh

# 3) 确认无误后一路部署到线上（含版本与资产比对）
bash .dsh/skills/deploy-blog/scripts/release.sh --deploy

# 4) 隔离副本冒烟（真实库副本 + 真实产物，跑完自动清理）
bash .dsh/skills/deploy-blog/scripts/smoke-remote.sh
```

第 2 步跑完会打印远程归档路径；第 3 步会把它交给 `/opt/blog/deploy.sh`，
那个脚本自己会做「部署前备份 → 解包 → 原生模块校验 → 原子切软链 → 探活 →
失败自动回滚 → 只保留最近 3 个 release」。

**紧急热修**（明知测试没跑全）：`--skip-verify --deploy`，但**不允许**在脏工作区上跑
（那是版本漂移的主要来源）。

## 二、每一步在防什么（做手工操作时也要照着做）

### 1. 预检

- 分支必须是 `master`，工作区必须干净，最好已 push。
- 产物里的 `.build-info.json` 会记录 commit / dirty / builtAt；
  `dirty=true` 的产物**不可复现**，线上出问题没法用 git 对回来。

### 2. 校验

```bash
node node_modules/typescript/bin/tsc --noEmit
npm test          # 245 个单测（含快照哈希、草稿协议、路由守卫）
npm run build
```

> **不要用 `npm run lint` 当门禁**：这个仓库的 lint 脚本调用 `next lint`，
> 而 Next 16 已经移除该命令，跑起来只会报
> `Invalid project directory provided … /lint`。这是既有问题，不是本次改动引入的。

行为层面的回归在浏览器套件里，发布前如果改过后台/编辑器，至少跑：

```bash
npm run test:editor && npm run test:workbench && npm run test:publish && npm run test:autosave
```

### 3. 打包

```bash
rm -rf dist && npm run build:dist
tar czf dist-upload.tar.gz -C dist .     # ← 必须在 dist 内部打包
```

`-C dist .` 不能省：服务端 `tar xzf -C $NEW` 之后要**直接**看到 `server.js`。
少了它，文件会落到 `$NEW/dist/...`，部署脚本会判"产物缺少 server.js"。

### 4. 上传

```bash
scp dist-upload.tar.gz <host>:/tmp/blog-dist-<sha>.tar.gz
ssh <host> "sha256sum /tmp/blog-dist-<sha>.tar.gz"
# 与本地 sha256sum dist-upload.tar.gz 一致才继续
```

### 5. 部署

```bash
ssh <host> '/opt/blog/deploy.sh /tmp/blog-dist-<sha>.tar.gz'
```

前置条件（脚本会自己检查，不满足就拒绝）：

- `systemctl show blog -p WorkingDirectory --value` == `/opt/blog/current`
- `/usr/local/bin/blog-backup` 可执行（备份失败即中止）
- `/opt/blog/shared/native/better_sqlite3.node` 存在

### 6. 验证（三层，缺一不可）

```bash
node scripts/verify-deploy.mjs        # 本地 HEAD vs 线上 healthz.commit
node scripts/verify-assets.mjs        # 本地 dist 的 CSS/JS vs 线上真实下发
bash .dsh/skills/deploy-blog/scripts/smoke-remote.sh   # 隔离副本上跑真实交互
```

三层各管一件事，不能互相替代：

| 层 | 能证明 | 证明不了 |
| --- | --- | --- |
| healthz | 进程活着、库能读、跑的是哪个 commit | 页面能不能渲染 |
| verify-assets | 静态资源确实换成新的了 | 交互逻辑对不对 |
| 隔离冒烟 | 登录 / 编辑 / 自动保存 / 摘要 / 发布 / 移动端都通 | 真实用户流量下的性能 |

### 7. 收尾

```bash
ssh <host> 'rm -f /tmp/blog-dist-*.tar.gz'     # release.sh 会自动做
ssh <host> 'systemctl show blog -p MemoryCurrent -p MemoryPeak --value'
ssh <host> 'journalctl -u blog -n 30 --no-pager -o cat'
```

内存：`MemoryHigh=300M`。上传大图时进程会按约 6.5× 放大，
如果 `基线 + 6.5 × 上传上限 > 300M`，一次上传就能把整站顶进 cgroup 节流。

## 三、回滚

```bash
ssh <host> '/opt/blog/deploy.sh --rollback'   # 切到上一版并等探活
ssh <host> '/opt/blog/deploy.sh --list'       # 看现有版本与当前指向
```

回滚只切代码，**不碰数据库**。如果这次发版带过数据迁移（`lib/migrations.ts`），
回滚后旧代码仍会面对新 schema —— 迁移必须是只增不改的，否则要先恢复库：

```bash
/usr/local/bin/blog-backup                     # 先留一份现状
# 恢复步骤见 deploy/README.md「3.3 恢复步骤」
```

## 四、常见故障对照

| 现象 | 先查什么 |
| --- | --- |
| 502 | `systemctl status blog`，看是否 OOM 或起不来；`journalctl -u blog -n 100` |
| 页面无样式 | `verify-assets`；多半是 `build:dist` 没跑或 tar 层级错 |
| 部署脚本报 WorkingDirectory 不对 | `sed -i 's\|^WorkingDirectory=.*\|WorkingDirectory=/opt/blog/current\|' /etc/systemd/system/blog.service && systemctl daemon-reload` |
| healthz 没有 `commit` 字段 | 那个产物是加版本戳之前构建的，重新 `build:dist` |
| 改了代码但线上没变 | 是不是手工 cp 了文件？用 `deploy.sh`；或 current 软链没切 |
| 上传报 413 | 只改了应用层没改 nginx（`client_max_body_size` 与 Next 两层要一致） |
| 上传后全站卡死 | `cat /proc/$(systemctl show blog -p MainPID --value)/wchan`，返回 `mem_cgroup_handle_over_high` 即被节流 |

## 五、脚本清单

| 文件 | 作用 | 跑在哪 |
| --- | --- | --- |
| `scripts/release.sh` | 预检 → 校验 → 打包 → 上传 →（`--deploy`）部署与校验 | 本地 |
| `scripts/smoke-remote.sh` | 起隔离实例 + 隧道 + 冒烟 + 清理，一条命令 | 本地（远端执行） |
| `scripts/smoke.mjs` | 冒烟断言本体（Playwright） | 本地 |
| `scripts/staging.sh` | 生产库副本 + 临时实例的 up/down/status | 服务器（root） |

依赖：本机有 `ssh` 到 `DEPLOY_HOST`（默认 `aliyun-ecs`，root）、`scp`、
Playwright Chromium（`npx playwright install chromium`）。

## 六、报告格式

发完之后对用户说清楚四件事，不要只说"部署成功"：

1. **版本**：commit、release 目录名、`reproducible`
2. **验证**：healthz / 资产比对 / 隔离冒烟各过了多少条
3. **数据**：schema 版本、posts 数、有没有跑迁移
4. **退路**：回滚命令与上一版目录名
