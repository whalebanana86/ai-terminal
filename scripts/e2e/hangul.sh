#!/bin/bash
# 터미널 한글 입력 검증: 실제 macOS 입력기(두벌식)를 거친 키 입력으로 "한글 안녕⏎" 을 쳐서 PTY 가 받은 바이트를 확인한다.
# 준비: AITERM_CLAUDE_BIN=$PWD/scripts/e2e/echo-agent.py AITERM_AUTOMATION_SOCKET=/tmp/aiterm-auto.sock pnpm tauri dev --features automation
# 키 입력은 automation 소켓의 {"keys": ...} 로 앱 자기 창에만 보낸다(손쉬운 사용 권한 불필요, 앱이 잠깐 앞으로 나옴).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
EVAL="$HERE/../aiterm-eval.py"
CWD=${1:-$(cd "$HERE/../.." && pwd)}
keys() { python3 - "$1" <<'PY'
import json, socket, sys
s = socket.socket(socket.AF_UNIX); s.connect("/tmp/aiterm-auto.sock")
s.sendall((json.dumps({"keys": json.loads(sys.argv[1]), "delayMs": 120, "inputSource": "com.apple.inputmethod.Korean.2SetKorean"}) + "\n").encode())
s.makefile().readline()
PY
}
f=$(mktemp); cat > "$f" <<JS
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const st = () => window.__aitermStore.getState();
st().setFocusWorktree('$CWD'); await wait(1200);
const ex = await window.__TAURI_INTERNALS__.invoke('exec_start', {args: {agent: 'claude', mode: 'new', cwd: '$CWD', cols: 100, rows: 30}});
await st().refreshExecs(); await st().refreshSessions(); await wait(600);
st().selectSession(ex.sessionId); await wait(1500);
document.querySelector('.term-host textarea').focus(); return ex.id;
JS
python3 "$EVAL" -f "$f" >/dev/null; rm -f "$f"
# 한글 띄어쓰기 안녕 Enter / ㅎ 지우고 1 Enter
keys '[[5,"g"],[40,"k"],[1,"s"],[15,"r"],[46,"m"],[3,"f"],[49," "],[2,"d"],[40,"k"],[1,"s"],[1,"s"],[32,"u"],[2,"d"],[36,"\r"],[5,"g"],[51,"\b"],[18,"1"],[36,"\r"]]'
sleep 1
out=$(python3 "$EVAL" "const ids = window.__aiterm.terminalIds(); return window.__aiterm.terminalText(ids[ids.length - 1])")
echo "$out" | sed 's/\\n/\n/g'
want="[한]
[글]
[ ]
[안]
[녕]
[\\\\r]
[1]
[\\\\r]"
got=$(echo "$out" | sed 's/\\n/\n/g' | grep -o '\[.*\]$' || true)
if [ "$got" = "$(printf '%b' "$want" | sed 's/\\\\/\\/g')" ]; then echo "통과"; else echo "실패"; exit 1; fi
