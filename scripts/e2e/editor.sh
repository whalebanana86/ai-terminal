#!/bin/bash
# 파일 편집 확장 기능 E2E: 시험 저장소를 만들고 scripts/e2e/editor.js 를 돌린 뒤 저장소 목록·설정을 원래대로 돌린다.
# 준비: AITERM_AUTOMATION_SOCKET=/tmp/aiterm-auto.sock pnpm tauri dev --features automation
# 키보드를 쓰지 않으므로 다른 앱을 쓰는 중에도 돌릴 수 있다(한글 입력기 시험은 따로, 앱이 맨 앞일 때).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$T"' EXIT
REPO="$T/repo"; PLAIN="$T/plain"
mkdir -p "$REPO/src" "$PLAIN"
git -C "$REPO" init -q -b main
printf 'export const hello = "hi";\n' > "$REPO/src/hello.ts"
printf 'a\r\nb\r\n' > "$REPO/win.txt"
printf '\xc7\xd1\xb1\xdb\n' > "$REPO/euckr.txt"
git -C "$REPO" add -A
git -C "$REPO" -c user.name=t -c user.email=t@t commit -qm init
git -C "$REPO" config user.name t; git -C "$REPO" config user.email t@t
echo x > "$PLAIN/readme.txt"
js=$(mktemp)
sed -e "s#__REPO__#$REPO#g" -e "s#__PLAIN__#$PLAIN#g" "$HERE/editor.js" > "$js"
out=$(python3 "$HERE/../aiterm-eval.py" -f "$js" || true); rm -f "$js"
echo "$out" | sed 's/\\n/\n/g; s/^"//; s/"$//'
# 시험 저장소를 앱 목록에서 지운다(앱 데이터는 설치된 앱과 같은 곳)
DB="$HOME/Library/Application Support/dev.aiterminal.app/ai-terminal.sqlite3"
sqlite3 "$DB" "DELETE FROM repositories WHERE path LIKE '$T/%' OR id LIKE '$T/%';" 2>/dev/null || true
if echo "$out" | sed 's/\\n/\n/g' | grep -qE '^"?(실패|오류) '; then echo "E2E 실패"; exit 1; fi
echo "E2E 통과"
