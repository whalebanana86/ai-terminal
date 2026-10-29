#!/usr/bin/env python3
"""소개 영상용 예시 데이터 보태기(scripts/demo/make_demo.py 다음에 돌린다).

  python3 scripts/promo/extra_demo.py <폴더>

- 지난주의 '토큰 만료' 세션: '기억 담아 새로' 장면에서 로그인 세션과 관련된 지난 기록으로 나온다.
- <폴더>/work/shared-lib: Git 훅이 든 남의 저장소(저장소 믿기 장면). 훅은 실행되지 않는다(믿기 전엔 꺼 둔다).
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "demo"))
import make_demo as d  # noqa: E402  (sys.argv[1] 로 같은 폴더를 쓴다)

t = d.t
d.claude_session(t("토큰 만료 처리", "Handle token expiry"), d.MAIN, "fix/token-refresh", 6 * d.DAY, [
    (t("로그인하고 한참 지나면 API 가 전부 401 로 실패해. 토큰이 만료되면 알아서 새로 받게 해 줘.",
       "A while after signing in, every API call fails with 401. Get a new token automatically when it expires."),
     [("Read", "src/lib/api.ts"), ("Write", "src/lib/refresh.ts"), ("Edit", "src/lib/api.ts"), ("Bash", "pnpm test -- auth")],
     t("401 이 오면 refresh 토큰으로 접근 토큰을 새로 받아 요청을 한 번 다시 보내게 했어요(src/lib/refresh.ts). refresh 토큰까지 만료됐으면 로그인 화면으로 보내요. 테스트 5개 통과.",
       "On a 401 it now gets a new access token with the refresh token and retries the request once (src/lib/refresh.ts). If the refresh token has expired too, it goes back to the login screen. 5 tests pass.")),
    (t("토큰은 어디에 저장하는 게 좋아?", "Where should the tokens be stored?"),
     [("Edit", "src/lib/refresh.ts")],
     t("접근 토큰은 메모리에만 두고, refresh 토큰은 httpOnly 쿠키로 받게 바꿨어요. 자바스크립트에서 읽을 수 없어 더 안전해요.",
       "The access token now stays in memory only, and the refresh token arrives as an httpOnly cookie. JavaScript can't read it, so it's safer.")),
])

lib = os.path.join(d.WORK, "shared-lib")
os.makedirs(lib, exist_ok=True)
d.git(lib, "init", "-q", "-b", "main")
d.write(os.path.join(lib, "README.md"), "# shared-lib\n\n" + t("받아 온 공용 라이브러리", "A shared library from another team") + "\n")
d.git(lib, "add", "-A")
d.git(lib, "commit", "-q", "-m", t("처음 받음", "Initial import"), when=d.NOW - 2 * d.DAY, who=d.JUN)
hook = os.path.join(lib, ".git", "hooks", "post-checkout")
d.write(hook, "#!/bin/sh\necho 'shared-lib " + t("훅", "hook") + "'\n")
os.chmod(hook, 0o755)
subprocess.run(["git", "-C", lib, "config", "filter.lfs-lite.smudge", "./tools/smudge.sh"], check=True)
print("보탬: 토큰 만료 세션, shared-lib")
