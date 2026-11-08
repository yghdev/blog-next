#!/usr/bin/env bash
#
# 博客访问日志汇总（C6，2026-11-08）。
#
# 日志格式定义在 /etc/nginx/conf.d/blog-cache.conf 的 `log_format blog_main`：
#   ... "GET /p/34 HTTP/2.0" 200 12345 "-" "UA" cache=HIT rt=0.012 urt=0.008
#
# 用法：
#   bash scripts/log-stats.sh                 # 默认读 /var/log/nginx/blog.access.log
#   bash scripts/log-stats.sh /path/to.log    # 指定文件（比如拉回本地分析）
#   bash scripts/log-stats.sh -n 5000         # 只看最近 5000 行
#
# 为什么要有这个脚本：缓存上线后如果没人看命中率，等于"优化了但不知道有没有用"。
# 一条命令回答四个问题：命中率多少、慢请求在哪、5xx 有没有、谁在刷。
set -euo pipefail

LOG="/var/log/nginx/blog.access.log"
LIMIT=0
while [ $# -gt 0 ]; do
  case "$1" in
    -n) LIMIT="${2:-0}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) LOG="$1"; shift ;;
  esac
done

[ -f "$LOG" ] || { echo "找不到日志：$LOG"; exit 1; }

# 取最近 N 行（0 = 全部）
read_log() {
  if [ "$LIMIT" -gt 0 ]; then tail -n "$LIMIT" "$LOG"; else cat "$LOG"; fi
}

TOTAL="$(read_log | wc -l)"
echo "日志：$LOG"
echo "行数：$TOTAL"
[ "$TOTAL" -eq 0 ] && exit 0

echo
echo "── 缓存状态 ──────────────────────────────"
read_log | grep -o 'cache=[A-Za-z_-]*' | sed 's/cache=//' | sort | uniq -c | sort -rn | awk '
  { cnt[$2] = $1; total += $1 }
  END {
    # 固定顺序输出，便于跨天对比
    split("HIT STALE UPDATING MISS BYPASS EXPIRED -", order, " ")
    for (i = 1; i <= 8; i++) {
      k = order[i]
      if (k in cnt) printf "  %-9s %6d  %5.1f%%\n", k, cnt[k], cnt[k] * 100 / total
    }
    hit = cnt["HIT"] + cnt["STALE"] + cnt["UPDATING"]
    printf "  ─────────────────────────────\n"
    printf "  命中率    %6.1f%%（HIT+STALE+UPDATING / 全部）\n", hit * 100 / total
  }'

echo
echo "── 响应耗时（rt，秒）─────────────────────"
read_log | grep -o 'rt=[0-9.]*' | sed 's/rt=//' | sort -n | awk '
  function pick(q) { i = int(NR * q); if (i < 1) i = 1; return v[i] }
  { v[NR] = $1 }
  END {
    if (NR == 0) { print "  （无数据）"; exit }
    printf "  p50 %.3fs · p90 %.3fs · p95 %.3fs · p99 %.3fs · max %.3fs\n",
      pick(0.50), pick(0.90), pick(0.95), pick(0.99), v[NR]
  }'

echo
echo "── 最慢的 5 个请求 ───────────────────────"
read_log | awk '
  {
    rt = 0
    for (i = 1; i <= NF; i++) if ($i ~ /^rt=/) { rt = substr($i, 4) + 0 }
    # 请求行在引号里：取 "METHOD PATH PROTO"
    line = $0
    if (match(line, /"[A-Z]+ [^"]+"/)) {
      req = substr(line, RSTART + 1, RLENGTH - 2)
      printf "  %6.3fs  %s\n", rt, req
    }
  }' | sort -rn | head -5

echo
echo "── 5xx / 429（按路径聚合，去掉查询串）────"
BAD="$(read_log | awk '
  {
    st = $9
    if (st ~ /^5/ || st == "429") {
      line = $0
      if (match(line, /"[A-Z]+ [^"]+"/)) {
        req = substr(line, RSTART + 1, RLENGTH - 2)
        split(req, a, " ")
        p = a[2]; sub(/\?.*/, "", p)
        printf "  %s  %s\n", st, p
      }
    }
  }' | sort | uniq -c | sort -rn | head -10)"
if [ -n "$BAD" ]; then echo "$BAD"; else echo "  （无）"; fi

echo
echo "── 请求量 Top 5 路径（去掉查询串）────────"
read_log | awk '
  {
    line = $0
    if (match(line, /"[A-Z]+ [^"]+"/)) {
      req = substr(line, RSTART + 1, RLENGTH - 2)
      split(req, a, " ")
      p = a[2]; sub(/\?.*/, "", p)
      print p
    }
  }' | sort | uniq -c | sort -rn | head -5 | awk '{ printf "  %6d  %s\n", $1, $2 }'
