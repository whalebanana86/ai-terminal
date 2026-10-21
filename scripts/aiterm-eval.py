#!/usr/bin/env python3
"""테스트용: 실행 중인 코드행방(automation 빌드)의 화면에서 JS 를 실행하고 결과를 출력한다.

사용: scripts/aiterm-eval.py 'return document.title'
      scripts/aiterm-eval.py -f script.js
환경변수 AITERM_AUTOMATION_SOCKET (기본 /tmp/aiterm-auto.sock)
"""
import json, os, socket, sys

def main():
    args = sys.argv[1:]
    quit_app = args[:1] == ["--quit"]
    if quit_app:
        js = ""
    elif args[:1] == ["-f"]:
        js = open(args[1]).read()
    else:
        js = " ".join(args) if args else sys.stdin.read()
    path = os.environ.get("AITERM_AUTOMATION_SOCKET", "/tmp/aiterm-auto.sock")
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(path)
    s.sendall((json.dumps({"quit": True} if quit_app else {"js": js, "timeoutMs": int(os.environ.get("AITERM_EVAL_TIMEOUT_MS", "60000"))}) + "\n").encode())
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = s.recv(65536)
        if not chunk:
            break
        buf += chunk
    resp = json.loads(buf)
    if not resp["ok"]:
        print("ERROR:", resp["value"], file=sys.stderr)
        sys.exit(1)
    v = json.loads(resp["value"])
    print(v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, indent=1))

main()
