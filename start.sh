#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

VENV_PYTHON="backend/.venv/bin/python3"
VENV_PIP="backend/.venv/bin/pip"
PIDFILE="logs/server.pid"
LOGFILE="logs/server.log"

# ─── 工具函数 ───

setup() {
    echo "[1/2] 安装依赖..."
    if [ ! -d backend/.venv ]; then
        python3 -m venv backend/.venv
    fi
    $VENV_PIP install -q -r requirements.txt
    mkdir -p logs
}

wait_for_url() {
    local url="$1"
    for _ in $(seq 1 30); do
        if curl -fsS "$url" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    echo "启动超时: $url" >&2
    return 1
}

# ─── 操作函数 ───

start_production() {
    setup
    kill_port_if_needed
    echo "[2/2] 启动服务 (后台模式)..."
    PYTHONPATH=backend nohup "$VENV_PYTHON" backend/app.py >> "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    wait_for_url "http://127.0.0.1:8730/api/health"
    echo "  服务已启动 PID: $(cat $PIDFILE)"
    echo "  访问: http://127.0.0.1:8730"
    echo "  日志: $LOGFILE"
}

start_debug() {
    setup
    kill_port_if_needed
    echo "[2/2] 启动服务 (调试模式)..."
    echo "  访问: http://127.0.0.1:8730"
    echo "  按 Ctrl+C 停止"
    echo ""
    PYTHONPATH=backend "$VENV_PYTHON" backend/app.py
}

stop() {
    if [ -f "$PIDFILE" ]; then
        local pid
        pid=$(cat "$PIDFILE")
        if kill -0 "$pid" 2>/dev/null; then
            echo "正在停止服务 (PID: $pid)..."
            kill "$pid" 2>/dev/null || true
            for _ in $(seq 1 5); do
                if ! kill -0 "$pid" 2>/dev/null; then
                    break
                fi
                sleep 1
            done
            kill -9 "$pid" 2>/dev/null || true
        fi
        rm -f "$PIDFILE"
        echo "  已停止"
    else
        echo "服务未运行"
    fi
}

status() {
    if [ -f "$PIDFILE" ]; then
        local pid
        pid=$(cat "$PIDFILE")
        if kill -0 "$pid" 2>/dev/null; then
            echo "运行中 (PID: $pid)"
            echo "访问: http://127.0.0.1:8730"
        else
            echo "已停止 (PID 文件残留)"
            rm -f "$PIDFILE"
        fi
    else
        echo "未运行"
    fi
}

kill_port_if_needed() {
    local port="${PORT:-8730}"
    local pids
    pids=$(lsof -ti :"$port" 2>/dev/null || true)
    if [ -n "$pids" ]; then
        echo "端口 $port 被 PID $pids 占用，正在释放..."
        kill $pids 2>/dev/null || true
        sleep 1
    fi
}

# ─── 交互菜单 ───

choose_mode() {
    echo ""
    echo "请选择启动模式:"
    echo "  1. debug    (前台，自动重载)"
    echo "  2. production (后台运行)"
    echo "  3. 取消"
    printf "请输入选项编号: "
    local choice
    read -r choice
    case "$choice" in
        1) start_debug ;;
        2) start_production ;;
        3) echo "已取消" ; exit 0 ;;
        *) echo "无效选项" ; exit 1 ;;
    esac
}

interactive_menu() {
    echo "============================================"
    echo "  历年涨跌幅 — GlobalAssetHistory"
    echo "============================================"
    echo ""
    echo "请选择操作:"
    echo "  1. 启动服务"
    echo "  2. 停止服务"
    echo "  3. 重启服务"
    echo "  4. 查看状态"
    echo "  5. 退出"
    printf "请输入选项编号: "
    local choice
    read -r choice
    echo ""
    case "$choice" in
        1) choose_mode ;;
        2) stop ;;
        3) stop; sleep 1; start_production ;;
        4) status ;;
        5) echo "已退出" ; exit 0 ;;
        *) echo "无效选项" ; exit 1 ;;
    esac
}

# ─── 入口 ───

case "${1:-}" in
    start|production)
        start_production
        ;;
    debug)
        start_debug
        ;;
    stop)
        stop
        ;;
    restart)
        stop
        sleep 1
        start_production
        ;;
    status)
        status
        ;;
    "")
        interactive_menu
        ;;
    *)
        echo "用法: ./start.sh [命令]"
        echo ""
        echo "  无参数      交互式菜单"
        echo "  start       生产模式 (后台)"
        echo "  debug       调试模式 (前台)"
        echo "  stop        停止服务"
        echo "  restart     重启"
        echo "  status      查看状态"
        exit 1
        ;;
esac
