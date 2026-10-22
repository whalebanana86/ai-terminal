#!/bin/bash
# X·스레드용 기능 소개 영상(30초 이내, 1920×1080 MP4)을 지어낸 예시 데이터로 만든다.
#
#   scripts/promo/make_promo.sh            # 장면 찍기 + 영상
#   scripts/promo/make_promo.sh --scenes   # 장면 그림만
#   scripts/promo/make_promo.sh --video    # 찍어 둔 장면으로 영상만 다시
#
# - 앱 창을 직접 녹화하지 않는다(화면 녹화 권한이 없어도 되게). 데모 앱(앱 ID dev.aiterminal.demo, 가짜 HOME)을
#   장면마다 맞춘 뒤 화면 구조를 떠서 헤드리스 크롬으로 그리고, 자막·확대를 얹은 타임라인을 프레임마다 그려 ffmpeg 로 묶는다.
# - 내 실제 기록·설치된 앱 설정은 건드리지 않는다. 결과: promo/ (git 제외)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
DEMO_DIR=${DEMO_DIR:-/tmp/aiterm-demo}
WORKDIR=${PROMO_DIR:-/tmp/aiterm-promo}
OUT="$ROOT/promo"
SOCK=/tmp/aiterm-auto.sock
export PATH="$HOME/.cargo/bin:$PATH"
export AITERM_AUTOMATION_SOCKET=$SOCK
mkdir -p "$WORKDIR/scenes" "$OUT"

# 헤드리스 크롬과 playwright-core
CHROME=${CHROME:-$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac*/"Google Chrome for Testing.app"/Contents/MacOS/"Google Chrome for Testing" 2>/dev/null | tail -1)}
[ -x "${CHROME:-}" ] || CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
export CHROME
export PW_DIR=${PW_DIR:-$WORKDIR/node}
[ -d "$PW_DIR/node_modules/playwright-core" ] || npm i -s --prefix "$PW_DIR" playwright-core@1 >/dev/null
render() { node "$HERE/render.mjs" "$@"; }

stop_app() {
  pkill -f "target/debug/ai-terminal" 2>/dev/null || true
  pkill -f "tauri dev" 2>/dev/null || true
  lsof -ti tcp:1420 | xargs -r kill 2>/dev/null || true
  rm -f "$SOCK"
}
js() { AITERM_EVAL_TIMEOUT_MS=60000 python3 "$ROOT/scripts/aiterm-eval.py" "$@"; }
scene() { js "return await window.__promo.$1"; }
snap() {
  js "return '<!doctype html>' + document.documentElement.outerHTML" > "$WORKDIR/scenes/$1.html"
  render shot "$WORKDIR/scenes/$1.html" "$WORKDIR/scenes/$1.png" "http://localhost:1420/"
  echo "  장면 $1"
}

if [ "${1:-}" != "--video" ]; then
  echo "── 예시 데이터: $DEMO_DIR"
  python3 "$ROOT/scripts/demo/make_demo.py" "$DEMO_DIR" >/dev/null
  WORK=$(cd "$DEMO_DIR/work" && pwd -P)
  echo "── 데모 앱 실행"
  stop_app
  trap stop_app EXIT
  cd "$ROOT"
  (AITERM_HOME="$DEMO_DIR/home" AITERM_CLAUDE_BIN="$ROOT/scripts/demo/fake-claude.sh" \
    nohup pnpm tauri dev --features automation --config '{"identifier":"dev.aiterminal.demo"}' > "$DEMO_DIR/app.log" 2>&1 &)
  for _ in $(seq 1 150); do [ -S "$SOCK" ] && break; sleep 2; done
  [ -S "$SOCK" ] || { echo "앱이 뜨지 않았습니다: $DEMO_DIR/app.log"; exit 1; }
  sleep 4
  # 화면 설정을 영상용으로(한국어·어둡게·세션 목록 펼침) 맞추고 다시 불러온다
  js "localStorage.setItem('aiterm.lang','ko'); localStorage.setItem('aiterm.theme','dark'); localStorage.removeItem('react-resizable-panels:agent-split:list:detail'); setTimeout(() => location.reload(), 50); return 1" >/dev/null
  sleep 5
  steps=$(mktemp)
  { sed "s|DEMO_WORK|$WORK|g" "$ROOT/scripts/demo/steps.js"; echo; sed "s|DEMO_WORK|$WORK|g" "$HERE/scenes.js"; echo; echo "return 1;"; } > "$steps"
  js -f "$steps" >/dev/null; rm -f "$steps"
  js "return await window.__demo.setup()" >/dev/null
  scene "setup()" >/dev/null
  echo "── 장면"
  scene "editor()" >/dev/null; snap editor
  scene "protect()" >/dev/null; snap protect
  scene "settings()" >/dev/null; snap settings
  scene "closeSettings()" >/dev/null
  scene "graph()" >/dev/null; snap graph
  js "return await window.__demo.chat(false)" >/dev/null
  js "return await window.__demo.allow()" >/dev/null
  scene "listOpen()" >/dev/null; snap list-open
  scene "listClosed()" >/dev/null; snap list-closed
  scene "listOpen()" >/dev/null
  stop_app
  trap - EXIT
fi

echo "── 터미널 글꼴 비교"
cp "$ROOT/node_modules/@xterm/xterm/lib/xterm.js" "$ROOT/node_modules/@xterm/xterm/css/xterm.css" "$ROOT/node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js" "$ROOT"/src/assets/fonts/HaengbangMono-*.woff2 "$WORKDIR/scenes/"
cp "$HERE/fontcompare.html" "$WORKDIR/scenes/"
node "$HERE/render.mjs" fontshot "$WORKDIR/scenes/fontcompare.html" "$WORKDIR/scenes/font.png"

[ "${1:-}" = "--scenes" ] && { echo "장면만 찍었습니다: $WORKDIR/scenes"; exit 0; }

echo "── 영상"
cp "$HERE/timeline.html" "$WORKDIR/scenes/timeline.html"
rm -rf "$WORKDIR/frames"
render frames "$WORKDIR/scenes/timeline.html" "$WORKDIR/frames" 29.5 30
NAME="code-whereabouts-$(date +%Y%m%d)"
ffmpeg -loglevel error -y -framerate 30 -i "$WORKDIR/frames/f%05d.png" -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart "$OUT/$NAME.mp4"
ffmpeg -loglevel error -y -ss 3.5 -i "$OUT/$NAME.mp4" -frames:v 1 "$OUT/$NAME-cover.png"
ls -la "$OUT/$NAME.mp4" | awk '{print "  " $5, $9}'
echo "끝"
