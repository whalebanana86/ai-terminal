#!/bin/bash
# X·스레드용 기능 소개 영상(40초 안쪽, 1920×1080 MP4)을 지어낸 예시 데이터로 만든다.
#
#   scripts/promo/make_promo.sh            # 데모 앱 빌드 + 장면 찍기 + 영상
#   scripts/promo/make_promo.sh --scenes   # 장면 그림만
#   scripts/promo/make_promo.sh --video    # 찍어 둔 장면으로 영상만 다시
#   NO_BUILD=1 …                           # 이미 빌드한 영상용 앱으로
#   PROMO_LANG=en …                        # 영어판(예시 데이터·앱 화면·자막 모두 영어, 파일 이름 끝에 -en)
#
# - 앱 창을 직접 녹화하지 않는다(화면 녹화 권한이 없어도 되게). 영상용 앱(앱 ID dev.aiterminal.promo, 가짜 HOME, automation 빌드)을
#   장면마다 맞춘 뒤 화면 구조를 떠서 헤드리스 크롬으로 그리고, 자막·확대를 얹은 타임라인을 프레임마다 그려 ffmpeg 로 묶는다.
# - 개발 서버(1420)는 쓰지 않는다 — 다른 프로젝트의 개발 서버와 부딪히지 않게 빌드한 화면(dist/)을 따로 띄운 포트에서 그린다.
# - 내 실제 기록·설치된 앱 설정은 건드리지 않는다. 영상용 앱의 데이터 폴더는 매번 비운다 — 시험용 데모 앱(dev.aiterminal.demo)에는
#   다른 시험에서 등록한 실제 저장소가 남아 있을 수 있어서 따로 쓴다. 받아 둔 작업 기억 모델은 옮겨 담는다. 결과: promo/ (git 제외)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
DEMO_DIR=${DEMO_DIR:-/tmp/aiterm-demo}
WORKDIR=${PROMO_DIR:-/tmp/aiterm-promo}
OUT="$ROOT/promo"
SOCK=/tmp/aiterm-auto.sock
PORT=${PROMO_PORT:-4319}
PROMO_LANG=${PROMO_LANG:-ko}
SUF=""
[ "$PROMO_LANG" = ko ] || SUF="-$PROMO_LANG"
SCENES="$WORKDIR/scenes$SUF"
APP="$ROOT/src-tauri/target/debug/bundle/macos/코드행방.app"
ID=dev.aiterminal.promo
DATA="$HOME/Library/Application Support/$ID"
DEMO_DATA="$HOME/Library/Application Support/dev.aiterminal.demo"
export AITERM_AUTOMATION_SOCKET=$SOCK
mkdir -p "$SCENES" "$OUT"

# 헤드리스 크롬과 playwright-core
CHROME=${CHROME:-$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac*/"Google Chrome for Testing.app"/Contents/MacOS/"Google Chrome for Testing" 2>/dev/null | tail -1)}
[ -x "${CHROME:-}" ] || CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
export CHROME
export PW_DIR=${PW_DIR:-$WORKDIR/node}
[ -d "$PW_DIR/node_modules/playwright-core" ] || npm i -s --prefix "$PW_DIR" playwright-core@1 >/dev/null
render() { node "$HERE/render.mjs" "$@"; }

js() { AITERM_EVAL_TIMEOUT_MS=${EVAL_MS:-60000} python3 "$ROOT/scripts/aiterm-eval.py" "$@"; }
SERVER=""
stop_all() {
  # 영상용 앱만 끈다(설치된 코드행방·다른 개발 서버는 건드리지 않는다)
  [ -S "$SOCK" ] && python3 "$ROOT/scripts/aiterm-eval.py" --quit >/dev/null 2>&1 || true
  rm -f "$SOCK"
  [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null || true
}
scene() { js "return await window.__promo.$1"; }
snap() {
  # 화면 구조에는 체크 상태(속성 말고 현재 값)가 없다: 떠 두기 전에 속성으로 옮긴다
  js "document.querySelectorAll('input[type=checkbox], input[type=radio]').forEach((b) => b.toggleAttribute('checked', b.checked)); return '<!doctype html>' + document.documentElement.outerHTML" > "$SCENES/$1.html"
  render shot "$SCENES/$1.html" "$SCENES/$1.png" "http://127.0.0.1:$PORT/"
  echo "  장면 $1"
}

if [ "${1:-}" != "--video" ]; then
  built=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null || true)
  if [ "${NO_BUILD:-0}" != 1 ] || [ "$built" != "$ID" ]; then
    echo "── 영상용 앱 빌드"
    (cd "$ROOT" && pnpm tauri build --debug --features automation --bundles app --config "{\"identifier\":\"$ID\"}" >/dev/null)
  fi
  echo "── 예시 데이터: $DEMO_DIR"
  DEMO_LANG=$PROMO_LANG python3 "$ROOT/scripts/demo/make_demo.py" "$DEMO_DIR" >/dev/null
  DEMO_LANG=$PROMO_LANG python3 "$HERE/extra_demo.py" "$DEMO_DIR" >/dev/null
  WORK=$(cd "$DEMO_DIR/work" && pwd -P)
  # 영상용 앱 데이터는 매번 새로(저장소 목록·화면 설정·작업 기억 DB). 작업 기억 모델만 남기거나 데모 앱에서 복제해 온다.
  KEEP=$(mktemp -d)
  for d in "$DATA/memory" "$DEMO_DATA/memory"; do
    if [ -f "$d/assets.ready" ]; then cp -cR "$d/model" "$d/runtime" "$d/assets.ready" "$KEEP/" && break; fi
  done
  rm -rf "$DATA" "$HOME/Library/WebKit/$ID" "$HOME/Library/Caches/$ID"
  mkdir -p "$DATA/memory"
  [ -f "$KEEP/assets.ready" ] && mv "$KEEP"/* "$DATA/memory/"
  rm -rf "$KEEP"
  echo "── 영상용 앱 실행"
  stop_all
  trap stop_all EXIT
  python3 "$HERE/serve.py" "$ROOT/dist" "$PORT" &
  SERVER=$!
  open -n --env AITERM_AUTOMATION_SOCKET=$SOCK --env AITERM_HOME="$DEMO_DIR/home" "$APP"
  for _ in $(seq 1 60); do [ -S "$SOCK" ] && js 'return 1' >/dev/null 2>&1 && break; sleep 1; done
  [ -S "$SOCK" ] || { echo "영상용 앱이 뜨지 않았습니다"; exit 1; }
  sleep 3
  # 화면 설정을 영상용으로(영상 언어·어둡게·세션 목록 펼침) 맞추고 다시 불러온다
  js "localStorage.setItem('aiterm.lang','$PROMO_LANG'); localStorage.setItem('aiterm.theme','dark'); localStorage.removeItem('react-resizable-panels:agent-split:list:detail'); setTimeout(() => location.reload(), 50); return 1" >/dev/null
  sleep 5
  steps=$(mktemp)
  { sed "s|DEMO_WORK|$WORK|g" "$ROOT/scripts/demo/steps.js"; echo; sed "s|DEMO_WORK|$WORK|g; s|DEMO_LANG|$PROMO_LANG|g" "$HERE/scenes.js"; echo; echo "return 1;"; } > "$steps"
  js -f "$steps" >/dev/null; rm -f "$steps"
  js "return await window.__demo.setup()" >/dev/null
  echo "── 작업 기억 준비: $(EVAL_MS=900000 js 'return await window.__promo.setup()')"
  echo "── 장면"
  scene "memoryStart()" >/dev/null; snap memory-start
  scene "memoryPreview()" >/dev/null; snap memory-preview
  scene "closeMemory()" >/dev/null
  scene "memorySettings()" >/dev/null; snap memory-settings
  scene "closeSettings()" >/dev/null
  scene "graph()" >/dev/null; snap graph
  scene "branches()" >/dev/null; snap branches
  scene "trust()" >/dev/null; snap trust
  scene "closeTrust()" >/dev/null
  stop_all
  trap - EXIT
fi

[ "${1:-}" = "--scenes" ] && { echo "장면만 찍었습니다: $SCENES"; exit 0; }

echo "── 영상"
sed "s|const LANG = \"ko\"|const LANG = \"$PROMO_LANG\"|" "$HERE/timeline.html" > "$SCENES/timeline.html"
cp "$ROOT/docs/buki.svg" "$SCENES/buki.svg"
rm -rf "$WORKDIR/frames"
DUR=$(sed -n 's/.*const DURATION = \([0-9.]*\).*/\1/p' "$HERE/timeline.html")
render frames "$SCENES/timeline.html" "$WORKDIR/frames" "$DUR" 30
NAME="code-whereabouts-$(date +%Y%m%d)$SUF"
ffmpeg -loglevel error -y -framerate 30 -i "$WORKDIR/frames/f%05d.png" -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart "$OUT/$NAME.mp4"
ffmpeg -loglevel error -y -ss 4 -i "$OUT/$NAME.mp4" -frames:v 1 "$OUT/$NAME-cover.png"
ls -la "$OUT/$NAME.mp4" | awk '{print "  " $5, $9}'
echo "끝"
