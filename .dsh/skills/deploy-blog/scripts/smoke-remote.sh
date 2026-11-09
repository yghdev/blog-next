#!/usr/bin/env bash
#
# 一条命令跑完"隔离副本冒烟"：服务器起临时实例 → 本地开隧道 → 跑 smoke.mjs →
# 无论成败都关隧道并删掉临时实例与数据副本。
#
# 为什么坚持用隔离副本而不是"直接在线上点一遍"：
#   - 冒烟会新建草稿壳、真发布一次、再转草稿。在生产库上做，等于往审计日志
#     和版本历史里写测试数据，而且一旦中途失败会留一条半成品文章。
#   - 副本用的是**同一份 release 产物 + 同一份真实数据**，所以能验出
#     "线上这套代码 + 这套数据"才会出现的问题（模板、摘要、草稿编码等）。
#
# 用法：
#   bash .dsh/skills/deploy-blog/scripts/smoke-remote.sh
#   DEPLOY_HOST=aliyun-ecs STAGING_PORT=8091 bash .../smoke-remote.sh
#
set -euo pipefail

# 项目根用 git 解析，不数 "../"：脚本挪位置（比如以后放进 scripts/）时
# 相对层级会静默错成 .dsh/ 或 skills/，而那时报错信息是"找不到 tsc"，
# 指不回真正的原因 —— 本次就踩过一次。
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$ROOT" ] || ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
HOST="${DEPLOY_HOST:-aliyun-ecs}"
PORT="${STAGING_PORT:-8091}"
TUNNEL_PORT="${TUNNEL_PORT:-18091}"
SKILL_DIR="$ROOT/.dsh/skills/deploy-blog"
TUNNEL_PID=""

cleanup() {
  if [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
  fi
  # 服务器侧一定要 down：失败时更要清，否则会把生产库副本留在 /tmp
  ssh -o BatchMode=yes "$HOST" 'bash -s -- down' < "$SKILL_DIR/scripts/staging.sh" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "== 1/4 在 $HOST 起隔离实例（生产库副本 + 临时账号） =="
# CSP_MODE 透传：默认 report-only，与线上一致；想验证 enforce 时
#   CSP_MODE=enforce bash smoke-remote.sh
# 这样冒烟覆盖的就是"切到强制模式后"的真实行为，而不是只测默认值。
OUT="$(ssh -o BatchMode=yes "$HOST" "CSP_MODE=${CSP_MODE:-report-only} bash -s -- up" < "$SKILL_DIR/scripts/staging.sh")"
echo "$OUT" | grep -v '^SMOKE_PASS=' | sed 's/^/   /'

SMOKE_BASE_LINE="$(echo "$OUT" | grep '^SMOKE_BASE=' || true)"
SMOKE_USER_LINE="$(echo "$OUT" | grep '^SMOKE_USER=' || true)"
SMOKE_PASS_LINE="$(echo "$OUT" | grep '^SMOKE_PASS=' || true)"
[ -n "$SMOKE_BASE_LINE" ] && [ -n "$SMOKE_USER_LINE" ] && [ -n "$SMOKE_PASS_LINE" ] \
  || { echo "!! 临时实例没有返回凭据，检查 staging.sh 输出"; exit 1; }

REMOTE_PORT="${SMOKE_BASE_LINE##*:}"
echo "== 2/4 打开 SSH 隧道 127.0.0.1:$TUNNEL_PORT → $HOST:$REMOTE_PORT =="
ssh -o BatchMode=yes -f -N -L "$TUNNEL_PORT:127.0.0.1:$REMOTE_PORT" "$HOST" 'sleep 300'
# -f 之后拿不到 pid，改用端口探活判断（并让 cleanup 用 pkill 兜底）
TUNNEL_PID="$(pgrep -f "ssh .*-L $TUNNEL_PORT:127.0.0.1:$REMOTE_PORT" | head -1 || true)"
for _ in $(seq 1 20); do
  curl -fsS -o /dev/null --max-time 1 "http://127.0.0.1:$TUNNEL_PORT/api/healthz" 2>/dev/null && break
  sleep 0.5
done
curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$TUNNEL_PORT/api/healthz" \
  || { echo "!! 隧道不通"; exit 1; }

echo "== 3/4 跑冒烟 =="
cd "$ROOT"
# node 定位（2026-11-09）：在 Git Bash / WSL 里跑时，PATH 里可能根本没有 node ——
# 之前这一步直接 "node: command not found"，整个冒烟白跑。
# 解析顺序：NODE_BIN 显式指定 > PATH 里的 node > WSL 下 Windows 版 node。
NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then NODE_BIN="$(command -v node)"
  elif [ -x "/mnt/c/Program Files/nodejs/node.exe" ]; then NODE_BIN="/mnt/c/Program Files/nodejs/node.exe"
  else
    echo "!! 找不到 node。设置 NODE_BIN=/path/to/node，或直接在 PowerShell 里跑："
    echo "   SMOKE_BASE=... SMOKE_USER=... SMOKE_PASS=... node .dsh/skills/deploy-blog/scripts/smoke.mjs"
    exit 2
  fi
fi
echo "   node: $NODE_BIN"
# 总上限 6 分钟：单个步骤有 20s 超时，这里兜住"万一某处仍然挂住"的情况，
# 免得 ssh 会话一直不返回、in-process 的调用方超时先死。
SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-360}"
if command -v timeout >/dev/null 2>&1; then
  SMOKE_LIMIT=(timeout "$SMOKE_TIMEOUT")
else
  SMOKE_LIMIT=()   # macOS 默认没有 timeout；此时没有总上限，单步仍有 20s 导航超时
fi
SMOKE_BASE="http://127.0.0.1:$TUNNEL_PORT" \
SMOKE_USER="${SMOKE_USER_LINE#SMOKE_USER=}" \
SMOKE_PASS="${SMOKE_PASS_LINE#SMOKE_PASS=}" \
  "${SMOKE_LIMIT[@]}" "$NODE_BIN" "$SKILL_DIR/scripts/smoke.mjs"
STATUS=$?

echo "== 4/4 清理临时实例 =="
cleanup
trap - EXIT INT TERM
echo "完成（退出码 $STATUS）"
exit "$STATUS"
