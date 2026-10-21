#!/bin/sh
# 코드행방 창만 찍는다(다른 화면은 찍지 않음). 사용: scripts/screenshot.sh out.png [프로세스이름]
set -e
OUT=${1:-/tmp/aiterm.png}
NAME=${2:-ai-terminal}
PID=$(pgrep -nx "$NAME")
DIR=$(cd "$(dirname "$0")" && pwd)
WID=$(swift "$DIR/window_id.swift" "$PID")
screencapture -x -o -l "$WID" "$OUT"
echo "$OUT"
