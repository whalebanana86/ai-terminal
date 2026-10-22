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
  echo "[코드행방] 앱 만들기를 건너뜁니다 (CI·AITERM_SKIP_APP·맥 아님)"
  exit 0
fi
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
export PATH="$HOME/.cargo/bin:$PATH"
if ! command -v cargo >/dev/null; then
  echo "[코드행방] Rust(cargo)가 없어 앱은 만들지 않았어요. https://rustup.rs 로 설치한 뒤 scripts/install_app.sh 를 실행하세요."
  exit 0
fi

echo "[코드행방] 앱을 만드는 중… (처음엔 몇 분 걸려요. 건너뛰려면 AITERM_SKIP_APP=1 pnpm install)"
pnpm tauri build --bundles app
APP="$ROOT/src-tauri/target/release/bundle/macos/코드행방.app"
[ -d "$APP" ] || { echo "[코드행방] 앱이 만들어지지 않았어요: $APP"; exit 1; }
# 로컬 Tauri 빌드는 실행 파일의 링커 서명만 남길 수 있다. 번들 리소스도 임시 서명으로 봉인한다.
# 이미 Developer ID 등으로 봉인된 번들은 그 서명을 유지하고 검증만 한다.
if [ ! -f "$APP/Contents/_CodeSignature/CodeResources" ]; then
  codesign --force --deep --sign - "$APP"
fi
codesign --verify --deep --strict "$APP"


DEST=/Applications
[ -w "$DEST" ] || DEST="$HOME/Applications"
mkdir -p "$DEST"
running=""
# ps 의 실행 파일 경로로 찾는다. 파이프로 grep -q 하면 pipefail 때문에 찾아도 실패로 끝나므로 목록을 먼저 받아 둔다.
procs=$(ps -A -o comm=)
# ps 는 한글 앱 이름을 자모가 나뉜 꼴(NFD)로 보여 줘서 이름 글자로는 비교하지 않는다(코드행방·AI Terminal 둘 다 실행 파일은 ai-terminal).
if grep -qE "^$DEST/[^/]+\.app/Contents/MacOS/ai-terminal\$" <<<"$procs"; then
  running=1
fi
# 기존 앱 이름만 옮긴다. 앱 식별자와 Application Support 데이터는 그대로 유지한다.
LEGACY="$DEST/AI Terminal.app"
if [ -d "$LEGACY" ] && [ ! -e "$DEST/코드행방.app" ] &&
   [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$LEGACY/Contents/Info.plist" 2>/dev/null)" = "dev.aiterminal.app" ]; then
  mv "$LEGACY" "$DEST/코드행방.app"
fi
# 켜져 있는 앱은 이미 메모리에 올라와 있어서 파일을 바꿔도 괜찮다
rm -rf "$DEST/코드행방.app"
ditto "$APP" "$DEST/코드행방.app"
echo "[코드행방] 설치했어요: $DEST/코드행방.app"
if [ -n "$running" ]; then
  echo "[코드행방] 앱이 켜져 있어요. ⌘Q 로 끄고 다시 열면 새 버전이 떠요."
else
  echo "[코드행방] 응용 프로그램 폴더나 Spotlight 에서 코드행방을 여세요."
fi
