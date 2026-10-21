#!/bin/bash
# 앱을 만들어 응용 프로그램 폴더에 넣는다. `pnpm install` 이 끝나면 저절로 불린다(package.json 의 postinstall).
#
#   scripts/install_app.sh          # 직접 실행해도 된다
#   AITERM_SKIP_APP=1 pnpm install  # 의존성만 설치하고 앱은 만들지 않기
#
# - CI(GitHub Actions 등)와 맥이 아닌 곳에서는 건너뛴다.
# - 앱이 켜져 있어도 끄지 않는다(앱 안에서 AI 대화를 돌리고 있을 수 있다). 파일만 바꾸고, 다시 켜면 새 버전이 뜬다.
set -euo pipefail
if [ -n "${CI:-}" ] || [ -n "${AITERM_SKIP_APP:-}" ] || [ "$(uname -s)" != "Darwin" ]; then
  echo "[ai-terminal] 앱 만들기를 건너뜁니다 (CI·AITERM_SKIP_APP·맥 아님)"
  exit 0
fi
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
export PATH="$HOME/.cargo/bin:$PATH"
if ! command -v cargo >/dev/null; then
  echo "[ai-terminal] Rust(cargo)가 없어 앱은 만들지 않았어요. https://rustup.rs 로 설치한 뒤 scripts/install_app.sh 를 실행하세요."
  exit 0
fi

echo "[ai-terminal] 앱을 만드는 중… (처음엔 몇 분 걸려요. 건너뛰려면 AITERM_SKIP_APP=1 pnpm install)"
pnpm tauri build --bundles app
APP="$ROOT/src-tauri/target/release/bundle/macos/AI Terminal.app"
[ -d "$APP" ] || { echo "[ai-terminal] 앱이 만들어지지 않았어요: $APP"; exit 1; }

DEST=/Applications
[ -w "$DEST" ] || DEST="$HOME/Applications"
mkdir -p "$DEST"
running=""
# pgrep -f 는 이 앱의 인자를 못 읽는 경우가 있어 ps 의 실행 파일 경로로 찾는다
ps -A -o comm= | grep -qF "$DEST/AI Terminal.app/Contents/MacOS/ai-terminal" && running=1
# 켜져 있는 앱은 이미 메모리에 올라와 있어서 파일을 바꿔도 괜찮다
rm -rf "$DEST/AI Terminal.app"
ditto "$APP" "$DEST/AI Terminal.app"
echo "[ai-terminal] 설치했어요: $DEST/AI Terminal.app"
if [ -n "$running" ]; then
  echo "[ai-terminal] 앱이 켜져 있어요. ⌘Q 로 끄고 다시 열면 새 버전이 떠요."
else
  echo "[ai-terminal] 응용 프로그램 폴더나 Spotlight 에서 AI Terminal 을 여세요."
fi
