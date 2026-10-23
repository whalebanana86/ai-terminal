#!/bin/bash
# README 그림(docs/screenshots/*.png)과 시연 영상(docs/demo.gif·mp4)을 지어낸 예시 데이터로 다시 만든다.
#
#   scripts/make_screenshots.sh            # 그림 + 영상
#   scripts/make_screenshots.sh --no-video # 그림만
#
# - 예시 저장소·세션 기록은 DEMO_DIR(기본 /tmp/aiterm-demo)에 새로 만든다. 그림에 이 경로가 보인다.
# - 앱은 개발 빌드(automation)를 앱 ID 만 바꿔(dev.aiterminal.demo) 띄운다. 가짜 HOME(AITERM_HOME)을 읽으므로
#   내 실제 Claude·Codex 기록과 설치된 앱의 설정·저장소 목록은 건드리지 않는다. 채팅은 가짜 claude 가 답한다.
# - 창만 찍는다(scripts/screenshot.sh). 영상은 ffmpeg 가 필요하다.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
DEMO_DIR=${DEMO_DIR:-/tmp/aiterm-demo}
OUT="$ROOT/docs/screenshots"
SOCK=/tmp/aiterm-auto.sock
VIDEO=1
[ "${1:-}" = "--no-video" ] && VIDEO=0
export PATH="$HOME/.cargo/bin:$PATH"
export AITERM_AUTOMATION_SOCKET=$SOCK

stop_app() {
  pkill -f "target/debug/ai-terminal" 2>/dev/null || true
  pkill -f "tauri dev" 2>/dev/null || true
  lsof -ti tcp:1420 | xargs -r kill 2>/dev/null || true
  rm -f "$SOCK"
}
js() { AITERM_EVAL_TIMEOUT_MS=60000 python3 "$ROOT/scripts/aiterm-eval.py" "$@"; }
step() { [ -n "${DEBUG:-}" ] && echo "  · $1" >&2; js "return await window.__demo.$1"; }
frame() {
  python3 - "$@" <<'PY'
import json, socket, sys
s = socket.socket(socket.AF_UNIX); s.connect("/tmp/aiterm-auto.sock")
s.sendall((json.dumps({"frame": [float(x) for x in sys.argv[1:5]]}) + "\n").encode()); s.makefile().readline()
PY
}
shot() {
  sleep 0.5
  # 창이 잠깐 화면 밖에 있으면 작은 미리보기로 찍힌다 → 제 크기로 찍힐 때까지 다시
  for _ in 1 2 3 4 5; do
    "$ROOT/scripts/screenshot.sh" "$DEMO_DIR/$1.png" >/dev/null
    [ "$(sips -g pixelWidth "$DEMO_DIR/$1.png" | awk '/pixelWidth/{print $2}')" -ge 2000 ] && break
    sleep 1
  done
  sips -Z 2000 "$DEMO_DIR/$1.png" --out "$OUT/$1.png" >/dev/null
  echo "  $OUT/$1.png"
}

echo "── 예시 데이터: $DEMO_DIR"
python3 "$HERE/demo/make_demo.py" "$DEMO_DIR" >/dev/null
WORK=$(cd "$DEMO_DIR/work" && pwd -P)

echo "── 앱 실행 (데모 ID, 가짜 HOME)"
stop_app
cd "$ROOT"
(AITERM_HOME="$DEMO_DIR/home" \
  nohup pnpm tauri dev --features automation --config '{"identifier":"dev.aiterminal.demo"}' > "$DEMO_DIR/app.log" 2>&1 &)
for _ in $(seq 1 150); do [ -S "$SOCK" ] && break; sleep 2; done
[ -S "$SOCK" ] || { echo "앱이 뜨지 않았습니다: $DEMO_DIR/app.log"; exit 1; }
sleep 4
trap stop_app EXIT
frame 60 60 1440 900
steps=$(mktemp)
{ sed "s|DEMO_WORK|$WORK|g" "$HERE/demo/steps.js"; echo; echo "return Object.keys(window.__demo).length;"; } > "$steps"
js -f "$steps" >/dev/null
rm -f "$steps"
step "setup()" >/dev/null

if [ "${1:-}" != "--video-only" ]; then
echo "── 그림"
mkdir -p "$OUT"
step "overview()" >/dev/null; shot overview
step "switchSession()" >/dev/null; step "openDiff()" >/dev/null; shot worktree-switch
step "image()" >/dev/null; shot image
step "back()" >/dev/null
step "stage()" >/dev/null; shot stage
step "graphMenu()" >/dev/null; shot graph-menu
step "closeMenu()" >/dev/null
step "worktrees()" >/dev/null; shot worktrees
step "newSession(false)" >/dev/null; shot new-session
step "closeDialog()" >/dev/null
fi

[ "${1:-}" = "--video-only" ] && VIDEO=1
if [ $VIDEO = 1 ]; then
  echo "── 시연 영상"
  # 상태를 처음으로 되돌리고(예시 데이터 다시 만들기) 같은 순서를 천천히 돌리며 창을 연달아 찍는다.
  stop_app
  python3 "$HERE/demo/make_demo.py" "$DEMO_DIR" >/dev/null
  (AITERM_HOME="$DEMO_DIR/home" \
    nohup pnpm tauri dev --features automation --config '{"identifier":"dev.aiterminal.demo"}' > "$DEMO_DIR/app.log" 2>&1 &)
  for _ in $(seq 1 150); do [ -S "$SOCK" ] && break; sleep 2; done
  sleep 4
  frame 60 60 1440 900
  steps=$(mktemp)
  { sed "s|DEMO_WORK|$WORK|g" "$HERE/demo/steps.js"; echo; echo "return Object.keys(window.__demo).length;"; } > "$steps"
  js -f "$steps" >/dev/null; rm -f "$steps"
  step "setup()" >/dev/null
  step "overview()" >/dev/null
  sleep 1
  FR="$DEMO_DIR/frames"; rm -rf "$FR"; mkdir -p "$FR"
  WID=$(swift "$ROOT/scripts/window_id.swift" "$(pgrep -nx ai-terminal)")
  # 찍은 시각을 이름에 넣어 두고, 나중에 프레임마다 실제 간격만큼 보여 준다.
  # 한 장 찍기에 실패해도(창이 잠깐 가려짐) 녹화는 계속한다
  ( set +e; while [ ! -f "$FR/stop" ]; do screencapture -x -o -l "$WID" "$FR/$(python3 -c 'import time;print(f"{time.time():.3f}")').png" 2>/dev/null || sleep 0.2; done ) &
  REC=$!
  sleep 2
  step "switchSession()" >/dev/null; sleep 1.2
  step "openDiff()" >/dev/null; sleep 1.5
  step "image()" >/dev/null; sleep 2
  step "back()" >/dev/null; sleep 0.8
  step "stage()" >/dev/null; sleep 1.2
  step "stageHunk()" >/dev/null; sleep 1
  step "graphMenu()" >/dev/null; sleep 1.8
  step "closeMenu()" >/dev/null
  step "worktrees()" >/dev/null; sleep 2
  touch "$FR/stop"; wait $REC 2>/dev/null || true
  python3 - "$FR" <<'PY'
import os, sys
d = sys.argv[1]
fs = sorted(f for f in os.listdir(d) if f.endswith(".png"))
ts = [float(f[:-4]) for f in fs]
with open(os.path.join(d, "list.txt"), "w") as out:
    for i, f in enumerate(fs):
        dur = (ts[i + 1] - ts[i]) if i + 1 < len(fs) else 2.0
        out.write(f"file '{f}'\nduration {dur:.3f}\n")
    out.write(f"file '{fs[-1]}'\n")
print(len(fs), "프레임", f"{ts[-1] - ts[0]:.1f}초")
PY
  ffmpeg -loglevel error -y -f concat -safe 0 -i "$FR/list.txt" -vf "fps=12,scale=1440:-2:flags=lanczos,format=yuv420p" -c:v libx264 -crf 24 -movflags +faststart "$ROOT/docs/demo.mp4"
  # 같은 화면이 이어지는 프레임은 빼고(mpdecimate) 바뀐 영역만 저장해야 GIF 가 작다(전체 프레임이면 30MB 넘음)
  ffmpeg -loglevel error -y -f concat -safe 0 -i "$FR/list.txt" \
    -vf "mpdecimate=hi=200:lo=64:frac=0.001,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=96:reserve_transparent=1[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" \
    -fps_mode vfr -gifflags +offsetting+transdiff "$ROOT/docs/demo.gif"
  ls -la "$ROOT/docs/demo.mp4" "$ROOT/docs/demo.gif" | awk '{print "  " $5, $9}'
fi
echo "끝"
