# 博客运维手册

> 最后更新：2026-10-21
> 站点：https://blog.yghsite.cn
> 代码仓库：本地 `blog-next`

---

## 一、架构

```
浏览器
  ↓ HTTPS (443)
Nginx（原证书沿用）
  ├─ /images/*  → /var/www/blog-images/（静态直出，不经 Node）
  └─ /*         → 127.0.0.1:8090
                    ↑
              内容页 30s 微缓存（C1，见 2.1）
                    ↓
              blog.service（systemd）
                    ↓
              /var/lib/blog/blog.db（SQLite）
```

| 组件 | 说明 |
|---|---|
| 应用 | Next.js 16 SSR，standalone 产物 |
| 代码位置 | `/opt/blog/` |
| 数据库 | `/var/lib/blog/blog.db` |
| 图片 | `/var/www/blog-images/` |
| 服务名 | `blog.service` |
| 端口 | `127.0.0.1:8090` |
| 内存限制 | MemoryHigh 300M / MemoryMax 400M |
| HTML 缓存 | nginx `proxy_cache`，zone `blog_html`，目录 `/var/cache/nginx/blog` |

---

## 二、日常命令

```bash
# 状态
systemctl status blog

# 重启（改代码后）
systemctl restart blog

# 日志
journalctl -u blog -f              # 实时
journalctl -u blog -n 100 --no-pager
journalctl -u blog --since today

# 内存
systemctl show blog -p MemoryCurrent | awk -F= '{printf "%d MB\n", $2/1048576}'

# nginx 改动后
nginx -t && systemctl reload nginx
```

### 2.1 HTML 微缓存（C1，2026-11-08）

Next 自托管动态页默认下发 `cache-control: private, no-cache, no-store`，
而 nginx 之前没有 `proxy_cache` —— 每个请求都进 Node 渲染。现在内容页
缓存 30 秒，后端故障时用 stale 顶住。

**两个文件，缺一不可**：

| 仓库文件 | 服务器位置 | 作用 |
|---|---|---|
| `deploy/nginx-cache.conf` | `/etc/nginx/conf.d/blog-cache.conf` | `proxy_cache_path` + 两个 `map`（哪些路径可缓存、什么时候 bypass） |
| `deploy/nginx-blog.conf` | `/etc/nginx/sites-available/blog` | `location /` 里的缓存指令 |

**四条安全边界**（改配置时不要动，`tests/nginx-cache.test.ts` 会红）：

1. **登录态 bypass**：带 `blog_session` cookie 的请求不读也不写缓存 ——
   站主改完内容刷新就能看到实时结果，不会被自己的缓存骗。
2. **RSC bypass**：`?_rsc=…` 查询串与 `RSC: 1` 头一律 bypass ——
   客户端导航要的是 RSC 载荷，拿缓存的 HTML 会直接坏掉。
3. **只缓存 200，且不忽略 `Set-Cookie`** —— 带 Set-Cookie 的响应 nginx
   默认不缓存，这是防止登录态写进公共缓存的安全网。
4. **5xx 不缓存**，只用 stale 顶住。

**验证**：

```bash
curl -sI https://blog.yghsite.cn/ | grep -i x-cache-status        # MISS → HIT
curl -sI -H 'Cookie: blog_session=<64位hex>' https://blog.yghsite.cn/ | grep -i x-cache-status  # BYPASS
curl -sI 'https://blog.yghsite.cn/p/34?_rsc=abc' | grep -i x-cache-status                        # BYPASS
curl -sI https://blog.yghsite.cn/api/healthz | grep -i x-cache-status                            # BYPASS
```

**紧急关闭**（怀疑缓存导致问题时）：

```bash
# 方式一：只清缓存，不改配置
rm -rf /var/cache/nginx/blog/* && systemctl reload nginx

# 方式二：整块关掉（注释掉 location / 里的 proxy_cache 一行即可）
sed -i 's/^        proxy_cache blog_html;/        # proxy_cache blog_html;/' /etc/nginx/sites-available/blog
nginx -t && systemctl reload nginx
```

**已知取舍**：TTL 30 秒、不做主动 purge（nginx 1.24 没有 `ngx_cache_purge`
模块）。发布后访客最多看到 30 秒旧内容；站主带 cookie 会 bypass，看到实时内容。
验收标准是「发布后 60 秒内可见」，30s TTL 满足。

### 2.2 媒体管线（C3，2026-11-08）

上传图片时除了原图，还会生成 **640 / 960 / 1280 三档 WebP**，正文与封面
用 `srcset` + `sizes` 让浏览器自己挑。手机拿 640 那档，桌面拿 1280 那档。

实测收益（2026-11-08，存量 22 张图）：`mimo3.png` 原图 1971KB →
640w **16KB** / 1280w **45KB**；`image1.png` 1094KB → 640w 9KB / 1280w 25KB。
变体文件总量约 1MB，原图 12MB。

**文件位置**：与原图同目录，命名 `<原名>-<宽度>.webp`
（`/images/2026/09/a.png` → `/images/2026/09/a-640.webp`）。
nginx 的 `/images/` 是 `alias /var/www/blog-images/`，变体自动可访问，**不需要改 nginx**。

**数据库**：`media.variants`（迁移 `0016_media_variants`），JSON：
`{"640":"/images/…-640.webp","960":…,"1280":…}`。

**存量补生成**（上传接口只处理新图）：

```bash
# 先 dry-run 看会做什么
DATA_DIR=/var/lib/blog UPLOAD_DIR=/var/www/blog-images \
  node --experimental-strip-types scripts/gen-variants.mjs

# 确认后真正生成（写文件 + 更新 media.variants）
DATA_DIR=/var/lib/blog UPLOAD_DIR=/var/www/blog-images \
  node --experimental-strip-types scripts/gen-variants.mjs --apply
```

脚本幂等：已有 `variants` 的行跳过，`--force` 才重算。

**内存边界（重要，别随手放宽）**：

| 约束 | 值 | 原因 |
|---|---|---|
| 源文件上限 | 4MB | 实测一张 2MB PNG 生成三档时进程峰值 RSS ≈ 154MB（Node 基线 57MB + libvips 解码 ≈ 100MB）。blog.service 的 MemoryHigh 是 300M、常驻约 90MB，8MB 的大图会把峰值推到 250MB+，逼近软上限 |
| 输入像素上限 | 2500 万 | 挡解压炸弹（20000×20000 的 PNG 解出来是 1.6GB） |
| 并发 | 串行 | 三档并行会让峰值内存翻三倍 |
| GIF | 跳过 | 转 WebP 会丢动画，"动图不动了"比"图大一点"严重 |

变体生成失败**不影响上传**：原图才是事实，变体只是优化项。

**对象存储 / CDN 评估（结论：暂不引入）**

| 方案 | 成本 | 收益 | 结论 |
|---|---|---|---|
| 现状：本地磁盘 + nginx | 0 | 12MB 图片、单机单地域 | **保持** |
| 七牛（代码已支持，`lib/storage.ts`） | 存储几元/月 + 流量 | 全球 CDN、省服务器带宽 | 暂不启用：当前流量远未到瓶颈，多一套密钥/备份/迁移成本 |
| 对象存储 + 图片处理（七牛/阿里云 OSS 的 `?imageView2`） | 同上 | 免去自己生成变体 | 暂不启用：本地 sharp 已经够用，且不依赖外部服务可用性 |

**什么时候该重新评估**：图片总量超过 200MB、或月流量超过服务器带宽的 50%、
或需要多地域访问。届时优先考虑"对象存储 + 保留本地兜底"（代码里
`lib/storage.ts` 的七牛分支已经写好，配好 AK/SK 即可切换，失败会自动退回本地）。

**已知缺口**：七牛直链的图片**不会**生成变体（变体要另外上传到对象存储）。
当前站点用的是本地存储，不受影响；切七牛前要先补这块。

### 2.3 可观测性与限流（C6，2026-11-08）

**访问日志**：博客单独记到 `/var/log/nginx/blog.access.log`，格式 `blog_main`
（定义在 `/etc/nginx/conf.d/blog-cache.conf`），比默认 combined 多三个字段：

```
... "GET /p/34 HTTP/2.0" 200 52140 "-" "UA" cache=HIT rt=0.012 urt=0.008
```

| 字段 | 含义 |
|---|---|
| `cache=` | `$upstream_cache_status`：HIT / MISS / BYPASS / STALE / EXPIRED / `-`（不可缓存） |
| `rt=` | `$request_time`：客户端感知的总耗时（秒） |
| `urt=` | `$upstream_response_time`：回源耗时（秒）；HIT 时是 `-` |

**一条命令看汇总**：

```bash
bash scripts/log-stats.sh                      # 读服务器上的默认路径
bash scripts/log-stats.sh -n 5000              # 只看最近 5000 行
bash scripts/log-stats.sh /tmp/blog.access.log # 分析拉回本地的日志
```

输出四块：缓存状态分布与命中率、响应耗时 p50/p90/p95/p99、最慢的 5 个请求、
5xx/429 按路径聚合、请求量 Top 5。

> 为什么要有这个：缓存上线后如果没人看命中率，等于"优化了但不知道有没有用"。
> 命中率低先看 `cache=-` 的占比 —— 那多半是 `/api/*` 与 `/search`（本来就不缓存）。

**限流**：`/api/search` 在网关层限流（`limit_req_zone blog_search`，
20 次/分钟 + burst 10，超限返回 **429**）。

- 为什么只限它：它是唯一"无缓存 + 有计算"的公开接口（每次查 FTS + 打分），
  应用层没有限流。登录与埋点已有应用层限流（`lib/rate-limit.ts`）。
- **`location /` 绝不能挂 limit_req** —— 内容页被限流意味着爬虫一多整站 429。
  `tests/nginx-cache.test.ts` 有一条断言守着这点。

**验证**：

```bash
# 日志格式生效
tail -3 /var/log/nginx/blog.access.log | grep -o 'cache=[A-Za-z_-]* rt=[0-9.]*'

# 限流生效（连打 30 次应出现 429）
for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code}
' \
  "https://blog.yghsite.cn/api/search?q=AI&n=$i"; done | sort | uniq -c

# 普通页面不受影响
for i in 1 2 3; do curl -s -o /dev/null -w '%{http_code} ' https://blog.yghsite.cn/; done
```

---

## 三、备份

### 3.1 自动备份

| 项 | 值 |
|---|---|
| 脚本 | `/usr/local/bin/blog-backup` |
| 定时 | `/etc/cron.d/blog-backup`，每日 **04:00** |
| 本地 | `/root/blog-backups/`，保留 14 份 |
| 异地 | 坚果云 `jianguoyun:blog_backup/`，保留 14 份 |
| 日志 | `/var/log/blog-backup.log` |

**备份内容**（同一个 tar.gz）：
- `blog.db` —— 文章 / 页面 / 说说 / 设置 / 访客埋点
- `images/` —— 本机图片（配置七牛图床后新的图不落盘）
- `artalk.db` —— 评论库（独立容器 Artalk 的 SQLite，**不在 blog.db 里**，P0-7 起纳入）
- `MANIFEST.txt` —— 时间 / 文章数 / 评论数 / 图片数

**不停机备份**：用 `sqlite3 .backup` 做在线一致性快照，WAL 与 delete 模式下都安全，不影响 blog 服务与 artalk 容器。

**每一步都有校验**：
1. 两份库各自 `PRAGMA integrity_check` 必须返回 `ok`
2. 已发布文章数必须 ≥ 1（防止备份到空库）
3. 打包内含 `MANIFEST.txt` 记录时间、文章数、评论数、图片数

> Artalk 库快照失败**不会**中止整个备份（博客数据是主线），但日志会打 `!!`、
> `MANIFEST.txt` 的「评论」一行会写失败原因 —— 出现 `!!` 就要去看
> `/var/log/blog-backup.log`，别只看"归档完成"。

### 3.2 手动备份

```bash
/usr/local/bin/blog-backup
ls -lh /root/blog-backups/
```

### 3.3 恢复步骤

```bash
cd /tmp && rm -rf restore && mkdir restore && cd restore

# 1. 下载最新备份
LATEST=$(rclone lsf jianguoyun:blog_backup/ --files-only | sort -r | head -1)
rclone copy "jianguoyun:blog_backup/$LATEST" . --no-traverse
tar xzf "$LATEST"

# 2. 检查
cat MANIFEST.txt
sqlite3 blog.db "PRAGMA integrity_check;"
sqlite3 artalk.db "PRAGMA integrity_check; SELECT COUNT(*) FROM comments;"

# 3. 停服务并替换（博客）
systemctl stop blog
cp /var/lib/blog/blog.db /var/lib/blog/blog.db.bak-$(date +%s)
cp blog.db /var/lib/blog/blog.db
rm -f /var/lib/blog/blog.db-wal /var/lib/blog/blog.db-shm
cp -a images/. /var/www/blog-images/
chown -R www-data:www-data /var/www/blog-images

# 3b. 恢复评论库（Artalk 容器）
#     先停容器再覆盖，Artalk 是 journal_mode=delete（非 WAL），没有 -wal/-shm 要清。
#     artalk.yml 里的 app_key / 管理员凭据**不在备份里**（含密钥，不进云端），
#     换机恢复时用 deploy/artalk/ 里的模板重建，再用 Artalk 后台重设管理员密码。
docker stop artalk
cp /opt/artalk/data/artalk.db /opt/artalk/data/artalk.db.bak-$(date +%s)
cp artalk.db /opt/artalk/data/artalk.db
chown root:root /opt/artalk/data/artalk.db   # 与容器挂载属主保持一致（原来是 root:root 644）
chmod 644 /opt/artalk/data/artalk.db
docker start artalk
docker logs --tail 20 artalk

# 4. 启动并验证
systemctl start blog
curl -sk -o /dev/null -w '%{http_code}\n' https://blog.yghsite.cn/
```

> **恢复演练已完成**（2026-10-21）：从坚果云下载最新备份，解包、校验 integrity=ok、
> 业务数据与线上完全一致（23 文章 / 4 页面 / 5 说说 / 4 评论 / 18 张图）。

### 3.4 备份脚本踩过的坑

**坚果云要求父目录必须已存在**，首次同步会报：
`AncestorsNotFound: 409 Conflict`
→ 脚本里已加 `rclone mkdir "$REMOTE"` 前置。

**评论库曾经完全不在备份里**（2026-11-06 发现，P0-7 修复）：Artalk 的数据在
`/opt/artalk/data/artalk.db`，是独立容器自己的 SQLite，blog-backup 只备
`blog.db` + 图片 —— 等于 6 条评论只有单副本。现在已并入同一个归档；
新增 Artalk 时同理：**新起的容器只要带自己的数据卷，就必须显式加进备份**。

---

## 四、发文章

1. 浏览器打开 https://blog.yghsite.cn/admin
2. 登录（账号密码 + TOTP 两步验证）
3. 点「写文章」
4. 支持 Markdown，工具栏可插入图片（直接上传，手机上可拍照）
5. 「存草稿」或「发布」

**手机端**：顶部栏右侧有搜索和菜单按钮，后台页面已适配响应式。

---

## 五、评论管理

2026-11-07（P0-7）起**只有 Artalk 一套**：

- 前台评论区接的是 Artalk（容器 `artalk`，https://artalk.yghsite.cn/sidebar/ 是管理面板）
- 审核 / 删除 / 封禁都在 Artalk 面板里做；博客后台的「评论」页已改为**历史只读**
  （展示本地 `comments` 表，该表不再写入任何新评论）
- 博客自建的 `POST /api/comments` 已下线（前台没有调用方，留着只是多一个攻击面）
- 数据在 `/opt/artalk/data/artalk.db`，**随每日备份一起走**（见 3.1）
- `artalk.yml` 不在备份里（含 app_key 等密钥）

---

## 六、访客统计

2026-10-30 起改为**自建埋点**，数据在 `blog.db` 的 `hits` 表里，
随每日备份一起走，不再依赖外部服务。后台入口：`/admin/visitors`。

| 指标 | 口径 |
|---|---|
| 访问量 PV | 每次浏览记 1（含切换前的历史基线） |
| 访客 UV | `HMAC(secret, IP+UA家族)` 去重，**近似值** |
| 访问次数 | 30 分钟无活动切一次 |
| 来源 | 只记会话落地页的来源域名 |

关键点：

- **不存 IP**、不种追踪 Cookie；UA 抹掉版本号（否则浏览器一升级就算新访客）
- 管理员（带有效后台会话）的访问**完全不记录**
- 爬虫 UA 在写入前过滤
- 历史数据：迁移 0013 把旧的 `settings['umami:*']` 冻结成 `stats:baseline:*`

### Umami（已停用，保留作历史）

Umami 容器目前仍可保留，用于核对切换前的历史数字；**它不再参与前台展示**。

```bash
cd /opt/umami
docker compose ps
```

确认新数据稳定后可以下线：

```bash
sudo systemctl disable --now umami-sync.timer
cd /opt/umami && docker compose down      # 数据卷保留，确认无误后再删
```

> **注意**：Umami 数据**不在博客备份里**。`settings` 里的 `umami:*` 与
> `stats:baseline:*` 在 `blog.db` 里，**在**备份里 —— 下线 Umami 前请确认
> 这两个键都在（`sqlite3 /var/lib/blog/blog.db "select key from settings where key like 'umami:%' or key like 'stats:%'"`）。

---

## 七、故障排查

| 现象 | 排查 |
|---|---|
| 站点 502 | `systemctl status blog`，看是否 OOM 被杀 |
| 上传视频报「没有收到文件」 | `next.config.ts` 的 `experimental.proxyClientMaxBodySize` 比 `client_max_body_size` 小，body 被静默截断成空 FormData。两层要一致 |
| 上传视频报 413 | 只改了应用层没改 nginx。nginx 直接拒，应用层无日志 |
| **上传后全站卡死 / 502 / 504** | 先看 `systemctl show blog -p MemoryPeak`。上传的内存放大约 **6.5×**，若 `基线 + 6.5 × 上传上限 > MemoryHigh(300M)`，一次上传就会把进程顶进 cgroup 节流（`wchan=mem_cgroup_handle_over_high`，D 状态），同进程所有请求连坐。**调小 `MAX_VIDEO_BYTES`**，并同步 Next / nginx 两层 |
| 确认是否被 cgroup 节流 | `cat /proc/$(systemctl show blog -p MainPID --value)/wchan`，返回 `mem_cgroup_handle_over_high` 即是 |
| 图片 404 | 检查 `/var/www/blog-images/` 是否存在、属主是否 www-data |
| 内存吃紧 | `free -m`、`systemctl show blog -p MemoryCurrent` |
| 改代码不生效 | 是否忘了 `systemctl restart blog` |
| 日志太多 | `journalctl --vacuum-size=100M` |

### 重新部署流程（2026-10-23 起：一条命令）

布局是 `releases/<戳>/` + `current` 软链，systemd 的 `WorkingDirectory=/opt/blog/current`。

```bash
# 1) 本地构建 + 打包
npm run build && npm run build:dist

# 2) 上传
scp dist-upload.tar.gz <your-ssh-host>:/tmp/blog-dist.tar.gz

# 3) 服务器上一条命令（自动备份 / 校验 / 切换 / 探活 / 失败回滚）
ssh <your-ssh-host>
/opt/blog/deploy.sh /tmp/blog-dist.tar.gz
```

其它子命令：

```bash
/opt/blog/deploy.sh --list        # 现有版本 + 当前指向
/opt/blog/deploy.sh --rollback    # 回滚到上一版（等健康再报成功）
```

**脚本会自己处理的事**（不再需要手工）：

| 步骤 | 说明 |
|---|---|
| 前置校验 | `WorkingDirectory` 不是 `/opt/blog/current` 就**拒绝部署**（防假成功） |
| 备份 | 调 `blog-backup`，失败即中止 |
| 原生模块 | 从 `/opt/blog/shared/native/better_sqlite3.node` 拷入，不再依赖 `/root/blog-stage` |
| 自检 | 部署前 `require('better-sqlite3')` 试加载，避免起来才 500 |
| 切换 | `ln -sfn` 原子切换 |
| 探活 | 20s 内等 healthz；失败自动切回上一版并重启 |
| 清理 | 保留最近 3 个 release，不动当前版 |

> ⚠️ **旧的「手工 rm -rf + cp -a」流程已废弃** —— 它没有原子性，中途失败会半新半旧，
> 而且要人去记原生模块那两步。
>
> ⚠️ **不要再把 `/opt/blog` 当扁平目录用**。它现在是「软链 + releases + shared」的容器，
> 直接往里 `cp` 文件不会生效（服务读的是 `current` 指向的 release）。

---

## 八、回滚到 WordPress

WordPress 文件与数据库完整保留在 `/var/www/html/wordpress` 和 MySQL 的 `wpdb` 库中。

```bash
systemctl stop blog && systemctl disable blog
rm -f /etc/nginx/sites-enabled/blog
ln -sf /etc/nginx/sites-available/wordpress.conf /etc/nginx/sites-enabled/wordpress.conf
nginx -t && systemctl reload nginx
systemctl enable --now mysql
systemctl enable --now php8.4-fpm
curl -sk -o /dev/null -w '%{http_code}\n' https://blog.yghsite.cn/
```

---

## 九、待办

- [ ] **Umami 统计准确性待调整**（单篇浏览量偶有不显示）
- [ ] WordPress 目录观察 30 天后清理（可省约 500MB 磁盘）
- [ ] 考虑把 Umami 数据库纳入备份
