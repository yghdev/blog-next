#!/usr/bin/env bash
#
# 本地侧发布流水线：预检 → 构建 → 打包 → 上传 →（可选）远程原子部署与校验。
#
# 为什么要有这个脚本而不是让人照着 README 敲：这套流程有 6 个容易漏的点，
# 每一个都曾经让"部署成功"变成谎话：
#   1. 工作区不干净 → 产物打的是 (dirty) 戳，线上版本无法用 git 复现
#   2. 忘了 build:dist → tar 里没有真实 node_modules，起来就 500
#   3. tar 打错层级（多套一层 dist/）→ 服务端找不到 server.js
#   4. 上传截断 → 解包后半截文件，探活失败才知道
#   5. 只在本地跑测试 → 通过了但线上 404（静态资源没进 standalone）
#   6. 部署完不比对 → 服务器上跑的还是上一版，而 healthz 看着一切正常
#
# 用法：
#   bash .dsh/skills/deploy-blog/scripts/release.sh              # 构建+上传，停在"可以部署了"
#   bash .dsh/skills/deploy-blog/scripts/release.sh --deploy     # 一路部署到线上并校验
#   bash .dsh/skills/deploy-blog/scripts/release.sh --skip-verify --deploy   # 跳过本地全量校验（紧急热修）
#
# 环境变量：
#   DEPLOY_HOST   默认 aliyun-ecs（~/.ssh/config 里的 Host，需要 root）
#   DEPLOY_BASE   默认 https://blog.yghsite.cn
#
set -euo pipefail

# 项目根用 git 解析，不数 "../"：脚本挪位置（比如以后放进 scripts/）时
# 相对层级会静默错成 .dsh/ 或 skills/，而那时报错信息是"找不到 tsc"，
# 指不回真正的原因 —— 本次就踩过一次。
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$ROOT" ] || ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
HOST="${DEPLOY_HOST:-aliyun-ecs}"
BASE="${DEPLOY_BASE:-https://blog.yghsite.cn}"
ARCHIVE="$ROOT/dist-upload.tar.gz"

DO_DEPLOY=0
SKIP_VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --deploy) DO_DEPLOY=1 ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    *) echo "未知参数：$arg"; exit 2 ;;
  esac
done

cd "$ROOT"
step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
die() { printf '\033[31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# ── 1. 预检：必须是干净的工作区，否则版本戳不可复现 ──────────────────
step "1/7 预检"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "master" ] || die "当前分支是 $BRANCH，这份流程只对 master 发版（避免把实验分支推上线）"

DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then
  echo "$DIRTY"
  die "工作区有未提交改动。先提交再发版 —— 产物必须能对应一个 commit，否则线上出问题无法用 git 对回来。"
fi

HEAD_SHA="$(git rev-parse --short HEAD)"
LOCAL_AHEAD="$(git rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null || echo 0)"
echo "分支 $BRANCH · HEAD $HEAD_SHA · 未推送 $LOCAL_AHEAD 个提交"
[ "$LOCAL_AHEAD" = "0" ] || echo "提示：先 git push，线上版本才可追溯"

# ── 2. 校验 ──────────────────────────────────────────────────────────
if [ "$SKIP_VERIFY" = "1" ]; then
  step "2/7 校验（已跳过）"
else
  step "2/7 类型检查 + 单元测试 + 构建"
  # 注意：npm run lint 在本仓库是坏的（next lint 已在 Next 16 移除），不要用它当门禁
  node node_modules/typescript/bin/tsc --noEmit
  npm test
  npm run build
fi

# ── 3. 打包 ──────────────────────────────────────────────────────────
step "3/7 打包 standalone 产物"
[ -d .next/standalone ] || npm run build
rm -rf dist
npm run build:dist

VERSION="$(node -e "const b=require('./dist/.build-info.json');console.log(b.shortCommit+(b.dirty?' (dirty)':''))")"
REPRO="$(node -e "const b=require('./dist/.build-info.json');console.log(b.reproducible)")"
echo "产物版本：$VERSION · reproducible=$REPRO"
[ "$REPRO" = "true" ] || die "产物标记为不可复现（dirty），停止"

# tar 必须在 dist 内部打包：服务端解包后要**直接**看到 server.js
rm -f "$ARCHIVE"
tar czf "$ARCHIVE" -C dist .
tar tzf "$ARCHIVE" | grep -qx './server.js' || die "归档里没有 ./server.js，层级打错了"
tar tzf "$ARCHIVE" | grep -qx './.build-info.json' || die "归档里没有版本戳"

SUM="$(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
SIZE="$(du -h "$ARCHIVE" | cut -f1)"
echo "归档 $SIZE · sha256 ${SUM:0:16}…"

# ── 4. 上传并核对哈希 ────────────────────────────────────────────────
step "4/7 上传到 $HOST"
REMOTE="/tmp/blog-dist-$HEAD_SHA.tar.gz"
scp -o BatchMode=yes "$ARCHIVE" "$HOST:$REMOTE"
REMOTE_SUM="$(ssh -o BatchMode=yes "$HOST" "sha256sum $REMOTE | cut -d' ' -f1")"
[ "$REMOTE_SUM" = "$SUM" ] || die "上传后哈希不一致（$REMOTE_SUM ≠ $SUM）：传输被截断，别继续"
echo "哈希一致"

if [ "$DO_DEPLOY" != "1" ]; then
  step "5/7 已停在上传完成"
  cat <<EOF
下一步（确认无误后执行）：

  bash .dsh/skills/deploy-blog/scripts/release.sh --deploy

或手工：

  ssh $HOST '/opt/blog/deploy.sh $REMOTE'
EOF
  exit 0
fi

# ── 5. 远程原子部署 ──────────────────────────────────────────────────
step "5/7 远程原子部署（自动备份 / 探活 / 失败回滚）"
ssh -o BatchMode=yes "$HOST" "/opt/blog/deploy.sh $REMOTE"

# ── 6. 版本与资产核对 ────────────────────────────────────────────────
step "6/7 版本与静态资产核对"
node scripts/verify-deploy.mjs "$BASE/api/healthz"
node scripts/verify-assets.mjs "$BASE"

# ── 7. 收尾 ──────────────────────────────────────────────────────────
step "7/7 收尾"
ssh -o BatchMode=yes "$HOST" "rm -f $REMOTE" || true
echo "已删除服务器上的上传归档"
echo
echo "发布完成：$VERSION → $BASE"
echo "回滚：ssh $HOST '/opt/blog/deploy.sh --rollback'"
echo "建议接着跑隔离冒烟：见 SKILL.md「第 5 步」"
