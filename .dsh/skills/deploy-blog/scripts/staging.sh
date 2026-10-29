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
#   6. 实例用 systemd-run 起成**临时 unit**，不用 `sudo ... &`。
#      原因（实跑踩到）：`sudo -u blog ... &` 起的进程会继承 ssh 会话的
#      stdout/stderr 管道，ssh 要等所有持有管道的进程退出才返回 —— 于是
#      `ssh host 'bash -s -- up'` 明明打完了输出却一直挂着，直到超时。
#      套 setsid / nohup / </dev/null 都无效（管道仍被 node 继承）。
#      临时 unit 还能顺带拿到独立 cgroup：stop 一次收掉整棵树，不留孤儿。
set -euo pipefail

ROOT=/opt/blog/current
STATE=/tmp/blog-staging.state
UNIT=blog-staging-smoke
PORT="${STAGING_PORT:-8091}"
DATA_DIR_PROD=/var/lib/blog

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
die() { log "!! $*"; exit 1; }

# 端口 -> 监听进程 PID。找不到时输出空串并返回 0。
#
# 为什么不能直接写 PID="$(ss ... | grep -oP ... | head -1)"：
# 在 `set -e` + `pipefail` 下，grep 没匹配会让整条管道返回 1，
# **赋值本身失败**，脚本静默退出（本次实跑时 down 就是这么无声无息地退出 1）。
# 结尾的 `|| true` 是这句的全部意义。
listener_pid() {
  ss -lptnH "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true
}

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
    UNIT="${STAGING_UNIT:-blog-staging-smoke}"
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

    # 起进程：临时 systemd unit，端口只绑回环，数据目录指向副本。
    # 用 unit 而不是 `sudo ... &`：见文件头第 6 条（ssh 会挂住 / 孤儿进程）。
    systemd-run --unit="$UNIT" --uid=blog --gid=blog --working-directory="$ROOT" \
      --setenv=NODE_ENV=production --setenv=PORT="$PORT" --setenv=HOSTNAME=127.0.0.1 \
      --setenv=DATA_DIR="$TMP" --setenv=UPLOAD_DIR="$UPLOADS" --setenv=TZ=UTC \
      --collect /usr/bin/node server.js >/dev/null 2>&1 \
      || die "systemd-run 起不来（unit 名 $UNIT 是否已被占用？）"

    for _ in $(seq 1 30); do
      curl -fsS -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/api/healthz" 2>/dev/null && break
      sleep 1
    done
    if ! curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/healthz" 2>/dev/null; then
      journalctl -u "$UNIT" -n 20 --no-pager 2>/dev/null | tail -20
      systemctl stop "$UNIT" 2>/dev/null || true
      die "临时实例没起来"
    fi

    # 记监听端口的 PID 并核对 DATA_DIR：这是"这个进程是我的副本"的唯一凭据。
    # （不记 $! —— 那是 systemd-run 客户端的 PID，与 node 无关。）
    NODE_PID="$(listener_pid "$PORT")"
    [ -n "${NODE_PID:-}" ] || die "拿不到临时实例的 PID（端口 $PORT）"
    ACTUAL_DATA="$(tr '\0' '\n' < "/proc/$NODE_PID/environ" 2>/dev/null | sed -n 's/^DATA_DIR=//p')"
    [ "$ACTUAL_DATA" = "$TMP" ] || die "PID $NODE_PID 的 DATA_DIR=$ACTUAL_DATA，不是本次副本，拒绝接管"

    umask 077
    printf 'TMP=%s\nPID=%s\nUNIT=%s\nPORT=%s\nUSERNAME=%s\nPASSWORD=%s\n' \
      "$TMP" "$NODE_PID" "$UNIT" "$PORT" "$USERNAME" "$PW" > "$STATE"
    chmod 600 "$STATE"

    log "临时实例已就绪（端口 $PORT，数据目录 $TMP）"
    echo "SMOKE_BASE=http://127.0.0.1:$PORT"
    echo "SMOKE_USER=$USERNAME"
    echo "SMOKE_PASS=$PW"
    ;;

  down)
    need_root

    # 允许两种入口：正常 down（有 state 文件），以及"上次崩在清理中间"的孤儿清理。
    # 孤儿也能清，是因为 up 一旦成功就必然在 /proc/<pid>/environ 留下可核对的
    # DATA_DIR —— 那才是"这个进程是我的"的唯一凭据，state 文件只是缓存。
    TMP=""; PID=""; UNIT=""; PORT="${STAGING_PORT:-8091}"
    UNIT_DEFAULT=blog-staging-smoke
    if [ -f "$STATE" ]; then
      # shellcheck disable=SC1090
      . "$STATE"
      PORT="${PORT:-$STAGING_PORT}"
      UNIT="${UNIT:-$UNIT_DEFAULT}"
    else
      log "没有 state 文件，尝试按端口清孤儿（仅当 DATA_DIR 是 /tmp 副本）"
    fi

    # 停 unit（整棵树一起收）。没有 state 时按默认 unit 名兜底。
    if systemctl is-active --quiet "${UNIT:-$UNIT_DEFAULT}" 2>/dev/null; then
      systemctl stop "${UNIT:-$UNIT_DEFAULT}" 2>/dev/null || true
      log "已停止临时 unit ${UNIT:-$UNIT_DEFAULT}"
    fi

    # 兜底：unit 没起成但端口还占着 —— 只当 DATA_DIR 确实是 /tmp 副本时才 kill
    if curl -fsS -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/api/healthz" 2>/dev/null; then
      PID="$(listener_pid "$PORT")"
      if [ -n "${PID:-}" ]; then
        ACTUAL_DATA="$(tr '\0' '\n' < "/proc/$PID/environ" 2>/dev/null | sed -n 's/^DATA_DIR=//p')"
        case "$ACTUAL_DATA" in
          /tmp/blog-staging-*)
            kill -TERM "$PID" 2>/dev/null || true; sleep 2
            kill -0 "$PID" 2>/dev/null && kill -KILL "$PID" 2>/dev/null || true
            log "已停止残留进程 PID=$PID"
            ;;
          *) log "!! PID $PID 的 DATA_DIR=${ACTUAL_DATA:-读不到}，拒绝 kill"; exit 1 ;;
        esac
      fi
    fi

    # 删目录前再确认端口真的不响应了 —— 顺序反过来会出现
    # "库删了、进程还开着已删除文件的 fd" 这种最难查的状态。
    if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/healthz" 2>/dev/null; then
      log "!! 端口 $PORT 仍在响应，可能还有残留进程，未删除数据目录"
      ss -lptn "sport = :$PORT" 2>/dev/null || true
      exit 1
    fi

    # 清目录：state 里记的，以及按前缀扫到的孤儿（都只动 /tmp/blog-staging-*）
    for d in ${TMP:-} $(ls -d /tmp/blog-staging-* 2>/dev/null || true); do
      case "$d" in
        /tmp/blog-staging-*) [ -d "$d" ] && rm -rf "$d" && log "已删除 $d" ;;
      esac
    done
    rm -f "$STATE"
    log "临时实例与数据副本已删除"
    ;;

  status)
    if [ -f "$STATE" ]; then
      . "$STATE"
      printf '临时实例：unit %s，端口 %s，PID %s，目录 %s\n' "${UNIT:-?}" "$PORT" "$PID" "$TMP"
      curl -s --max-time 2 "http://127.0.0.1:$PORT/api/healthz" | head -c 200; echo
    else
      log "没有临时实例"
    fi
    ;;

  *)
    die "用法: staging.sh up|down|status"
    ;;
esac
