# blog-next

自建博客：Next.js 16 SSR + SQLite。数据完全在自己手里。

## 技术栈

- **Next.js 16**（App Router，standalone 输出）
- **SQLite**（better-sqlite3，单文件库）
- **无 CSS 框架**，手写设计系统（参考 xaoxuu.com / Stellar 的克制风格）
- 后台自带 Markdown 编辑器、图片上传、评论审核、TOTP 两步验证

## 目录结构

```
app/
  page.tsx              首页（文章列表）
  [slug]/page.tsx       文章 / 页面详情
  shuoshuo/page.tsx     说说
  archives/page.tsx     归档
  admin/                后台（登录、编辑、评论、设置）
  api/                  API 路由
components/             UI 组件
lib/
  db.ts                 SQLite 表结构与连接
  posts.ts              查询
  auth.ts               登录 / 会话 / TOTP / 限流
  markdown.ts           Markdown 渲染 + 目录
scripts/
  init-db.mjs           初始化数据库与管理账号
  migrate-wp.mjs        从 WordPress 转换结果导入
  package-standalone.mjs 打包部署产物
deploy/                 systemd / nginx / 部署说明
```

## 本地开发

```bash
npm install
set ADMIN_PASS=你的密码&& node scripts/init-db.mjs
npm run dev
```

访问 http://localhost:3000 ，后台在 /admin 。

## 数据

- 系统数据：`data/blog.db`（本地）或 `DATA_DIR` 指定
- 图片：`public/images/`（本地）或 `UPLOAD_DIR`
- 上线后分别在 `/var/lib/blog/` 与 `/var/lib/blog/images/`

## 部署

见 `deploy/README.md`。

## 设计与交互约束

见 `docs/design-system.md`。前台按移动端规范（安全区 / 44·48dp 热区 / 底部抽屉 /
软键盘），后台按 B 端规范（主操作唯一 / 浅底深字徽标 / 确认弹窗 / 五态）。
改布局前先读，改完跑文末的 lint。

## 安全

- 后台密码 bcrypt(12)
- TOTP 两步验证（可选开启，强烈建议）
- 登录限流：15 分钟内最多 5 次
- 评论限流：同 IP 10 分钟 3 条 + 蜜罐字段
- 评论默认待审核，后台手动通过
