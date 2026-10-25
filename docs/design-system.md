# 设计系统约束（B 端 + 移动端）

> 建立于 2026-10-25。这份文件是**可执行的约束**，不是风格建议。
> 改后台或移动端布局前先读一遍；改完跑一遍文末的 lint。

站点有两套界面，规范来源不同，不要混用：

| 界面 | 规范 | 关键词 |
| --- | --- | --- |
| 前台（读者看） | 移动端工业级规范 | 安全区、44/48dp 热区、底部抽屉、软键盘 |
| 后台 /admin | B 端工业级规范 | 主操作唯一、浅底深字徽标、确认弹窗、五态 |

---

## 一、令牌（app/globals.css :root）

**不要再写死颜色。** 全站语义色都走 token，暗色主题下自动切换：

| 令牌 | 用途 |
| --- | --- |
| --danger / --danger-bg / --danger-border | 删除、清空、不可逆操作 |
| --ok / --ok-bg / --ok-border | 成功、已发布、已通过 |
| --warn / --warn-bg / --warn-border | 待处理、草稿、需注意 |
| --info / --info-bg / --info-border | 中性提示、计数徽标 |
| --surface-2 / --lift-1 / --lift-2 | 悬浮层表面与投影 |
| --safe-top / --safe-bottom | 全面屏安全区（已包 env()） |
| --tap = 44px / --tap-lg = 48px | 最小触控热区 |

历史坑：--lift-1、--lift-2、--surface-2 曾被引用但**从未定义**，
导致 .article-nav-item 的 box-shadow 整条声明被浏览器丢弃（上下篇卡片一直没有投影）。
现在已补齐，改这些变量时注意别删。

## 二、B 端硬门禁（后台）

1. **主操作唯一**：一个操作区最多一个 .btn-primary。审核类「通过 / 垃圾」
   都用次级样式，不用颜色替人做决定。
2. **危险操作专用样式**：用 .btn-danger（浅底深字语义色），
   绝不用「主色 + 描红」，那是视觉诱导。
3. **不可逆操作必须过 ConfirmDialog**：标题中立只交代对象，
   描述写清连带后果，按钮是动宾文案（「彻底删除」「移入回收站」）。
   window.confirm 一律不用（不可样式化、手机上体验差、写不清后果）。
4. **徽标浅底深字**：Badge tone="ok|warn|danger|info" dot，
   必须带业务文案，禁止彩虹配色。
5. **空状态要有出口**：Empty title/hint/actions —— 说清为什么为空 + 给一个动作。
6. **列表骨架固定四段**：PageHeader → KpiRow → FilterBar → DataSection。
   页面里不写行内 padding / 魔法数字，全走 .admin-* / .data-* 类。
7. **数值列右对齐 + 等宽数字**（.data-row-meta、.kpi-value）。
8. **边框用半透明 1px 当 0.5px 用**：var(--border) / var(--border-strong)。

## 三、移动端硬门禁（前台 + 后台的手机态）

1. **安全区**：所有 fixed / sticky 的贴边容器必须避让 ——
   底边 calc(Npx + var(--safe-bottom))，顶边 calc(Npx + var(--safe-top))。
   @media (max-width: 820px) 里 .site-shell 与页脚已处理。
2. **触控热区 ≥44pt（iOS）/ 48dp（Android）**：小图标靠容器或 padding 扩，
   不改视觉尺寸。当前已达标：顶栏图标、抽屉关闭键、列表行、tag-pill、
   归档行、分页按钮、筛选条按钮、编辑器工具栏。
3. **滚动穿透**：浮层一律用 useScrollLock（components/ui/useScrollLock.ts）。
   **不要**只写 body.style.overflow = "hidden" —— iOS Safari 直接忽略，
   抽屉里滑一下底层页面跟着动。
4. **软键盘**：输入框聚焦由 MobileKeyboardGuard 滚到视口中部；
   手机端输入框字号钉 16px（globals.css 末尾），否则 iOS 会强制放大整页。
5. **键盘类型**：验证码 inputMode="numeric" + autoComplete="one-time-code"，
   搜索框 type="search" + enterKeyHint="search"。
6. **浮层高度用 dvh 不用 vh**：iOS 地址栏收放时 vh 不会跟着变，底部会被顶出屏。
7. **浮层挂 Portal 到 body**：顶栏有 backdrop-filter，会给 position:fixed
   创建新包含块，抽屉会被困在 54px 的头部里（本项目踩过）。
8. **不用原生 <table> 承载手机列表**：一律 .data-row 卡片，≤820px 自动折行。
9. **无横向滚动**：document.documentElement.scrollWidth === clientWidth。

## 四、浮层选型

| 场景 | 用什么 |
| --- | --- |
| 查看详情、保留列表上下文 | 侧边抽屉 / 同页展开 |
| 确认破坏性操作 | ConfirmDialog（桌面居中，手机自动变底部抽屉） |
| 移动端多选项、筛选 | BottomSheet（三分屏，≤80dvh） |
| 录入表单的浮层 | maskClosable={false}，退出必须点「取消」 |

## 五、交付前自查

```bash
cd blog-next
node node_modules/typescript/bin/tsc --noEmit
python3 ~/.dsh/skills/b-end-design-system/scripts/audit-design-rules.py app
python3 ~/.dsh/skills/b-end-design-system/scripts/audit-design-rules.py components
python3 ~/.dsh/skills/mobile-design-system/scripts/audit-mobile-design.py app
python3 ~/.dsh/skills/mobile-design-system/scripts/audit-mobile-design.py components
npm run build
```

真机量一遍（headless Chrome + CDP）比肉眼可靠：

- document.documentElement.scrollWidth > clientWidth → 有横向溢出
- 所有 a / button 的 getBoundingClientRect() 宽高 → 找出 < 44 的
- 打开浮层后 getComputedStyle(document.body).position → 应为 fixed
