#!/usr/bin/env bash
#
# 生产构建冒烟用的**隔离实例**（在服务器上运行，不在本地）。
#
# 为什么需要它：部署脚本只证明"进程起来了、healthz 返回 ok"。它证明不了
# 编辑页能渲染、草稿能存、发布后 excerpt 正确 —— 而这些恰恰是改版最容易
# 弄坏的东西。直接在**生产库**上点这些按钮会写脏数据，所以这里复制一份库、
# 起一个临时端口、用临时账号跑冒烟，跑完整份删掉。
#
# 用法（在本地，通过 ssh 把脚本喂给服务器）：
#   ssh <host> 'bash -s' < .dsh/skills/deploy-blog/scripts/staging.sh up
#   ... 跑 prod-smoke.mjs ...
#   ssh <host> 'bash -s' < .dsh/skills/deploy-blog/scripts/staging.sh down
#
# 也可以直接 ssh 上去执行本文件：bash staging.sh up|down|status
#
# 安全边界（每一行都是硬约束）：
#   1. 只**读** /var/lib/blog 的库，复制到 /tmp 下的临时目录；DATA_DIR 永远
#      指向副本。绝不把临时实例指到生产库。
#   2. sqlite 在 WAL 模式下，只复制 blog.db 会丢掉最近提交 —— 必须连
#      -wal / -shm 一起复制，否则冒烟跑在旧数据上，结论是假的。
#   3. 端口只绑 127.0.0.1，不对外开放；外部通过 ssh 隧道访问。
#   4. 临时管理员只写进**副本**，用完随目录一起删。
#   5. UPLOAD_DIR 指向 /tmp 下的空目录，冒烟不往真实图床写文件。
set -euo pipefail

ROOT=/opt/blog/current
STATE=/tmp/blog-staging.state
PORT="${STAGING_PORT:-8091}"
DATA_DIR_PROD=/var/lib/blog

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
die() { log "!! $*"; exit 1; }

need_root() {
  [ "$(id -u)" -eq 0 ] || die "需要 root：临时实例要以 blog 用户起、并且读 /var/lib/blog"
}

port_free() {
  ! curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/healthz" 2>/dev/null
}

case "${1:-}" in
  up)
    need_root
    [ -f "$STATE" ] && die "已经有一个临时实例在跑（$STATE）。先 down。"
    port_free || die "端口 $PORT 已被占用，换一个：STAGING_PORT=8092 bash staging.sh up"
    [ -f "$ROOT/server.js" ] || die "找不到 $ROOT/server.js —— /opt/blog/current 不对"
    [ -f "$DATA_DIR_PROD/blog.db" ] || die "找不到生产库 $DATA_DIR_PROD/blog.db"

    TMP="$(mktemp -d /tmp/blog-staging-XXXXXX)"
    UPLOADS="$TMP/uploads"
    mkdir -p "$UPLOADS"

    # 库副本：三个文件缺一不可（WAL 模式下 -wal 里有最新提交）
    cp "$DATA_DIR_PROD/blog.db" "$TMP/blog.db"
    for f in blog.db-wal blog.db-shm; do
      [ -f "$DATA_DIR_PROD/$f" ] && cp "$DATA_DIR_PROD/$f" "$TMP/$f" || true
    done

    # 临时管理员：只进副本，密码随机，只打印一次
    PW="smoke-$(head -c 18 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)"
    USERNAME="smoke-$(date +%s)"
    cat > "$TMP/mkadmin.mjs" <<'JS'
import Database from "/opt/blog/current/node_modules/better-sqlite3/lib/index.js";
import bcrypt from "/opt/blog/current/node_modules/bcryptjs/index.js";
const [dbPath, user, pass] = process.argv.slice(2);
const db = new Database(dbPath);
db.prepare("INSERT INTO users (username, password_hash, totp_enabled, role, created_at) VALUES (?, ?, 0, ?, ?)")
  .run(user, bcrypt.hashSync(pass, 4), "admin", new Date().toISOString());
JS
    chown -R blog:blog "$TMP"
    ( cd "$ROOT" && sudo -u blog /usr/bin/node "$TMP/mkadmin.mjs" "$TMP/blog.db" "$USERNAME" "$PW" ) \
      || die "临时管理员写入失败"

    # 起进程：端口只绑回环，数据目录指向副本
    ( cd "$ROOT" && sudo -u blog env \
        NODE_ENV=production PORT="$PORT" HOSTNAME=127.0.0.1 \
        DATA_DIR="$TMP" UPLOAD_DIR="$UPLOADS" TZ=UTC \
        nohup /usr/bin/node server.js > "$TMP/server.log" 2>&1 & echo $! > "$TMP/pid" )

    for _ in $(seq 1 30); do
      curl -fsS -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/api/healthz" 2>/dev/null && break
      sleep 1
    done
    curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/healthz" \
      || { tail -20 "$TMP/server.log"; die "临时实例没起来"; }

    umask 077
    printf 'TMP=%s\nPID=%s\nPORT=%s\nUSERNAME=%s\nPASSWORD=%s\n' \
      "$TMP" "$(cat "$TMP/pid")" "$PORT" "$USERNAME" "$PW" > "$STATE"
    chmod 600 "$STATE"

    log "临时实例已就绪（端口 $PORT，数据目录 $TMP）"
    echo "SMOKE_BASE=http://127.0.0.1:$PORT"
    echo "SMOKE_USER=$USERNAME"
    echo "SMOKE_PASS=$PW"
    ;;

  down)
    need_root
    if [ ! -f "$STATE" ]; then log "没有临时实例在跑"; exit 0; fi
    # shellcheck disable=SC1090
    . "$STATE"
    if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null || true
      sleep 1
      kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
    fi
    # 兜底：按端口找残留（只 kill 明确属于本实例的 node 进程）
    if curl -fsS -o /dev/null --max-time 1 "http://127.0.0.1:${PORT:-8091}/api/healthz" 2>/dev/null; then
      log "!! 端口仍在响应，需要人工检查（可能是别的进程）"
      exit 1
    fi
    [ -n "${TMP:-}" ] && [ -d "$TMP" ] && rm -rf "$TMP"
    rm -f "$STATE"
    log "临时实例与数据副本已删除"
    ;;

  status)
    if [ -f "$STATE" ]; then
      . "$STATE"
      printf '临时实例：端口 %s，PID %s，目录 %s\n' "$PORT" "$PID" "$TMP"
      curl -s --max-time 2 "http://127.0.0.1:$PORT/api/healthz" | head -c 200; echo
    else
      log "没有临时实例"
    fi
    ;;

  *)
    die "用法: staging.sh up|down|status"
    ;;
esac
