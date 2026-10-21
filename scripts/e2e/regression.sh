#!/bin/bash
# 실행 중인 AI Terminal(automation 빌드)에 대해 CLI 토큰 없이 도는 회귀 검증.
#   1) 앱을 띄운다: AITERM_AUTOMATION_SOCKET=/tmp/aiterm-auto.sock pnpm tauri dev --features automation
#   2) scripts/e2e/regression.sh
# 독립 테스트 저장소를 /private/tmp/aiterm-e2e-reg 에 새로 만든다(사용자 데이터는 건드리지 않음).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
EVAL="$HERE/../aiterm-eval.py"
R=/private/tmp/aiterm-e2e-reg
PASS=0; FAIL=0
ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (앱: '$2' / 기대: '$3')"; fi; }
js()   { python3 "$EVAL" "$1"; }

echo "── 준비: 테스트 저장소"
rm -rf "$R"; mkdir -p "$R"; cd "$R"
git init -q --bare origin.git
git init -q -b main demo; cd demo
git config user.name reg; git config user.email reg@local
echo a > a.txt; git add -A; git commit -qm c1
echo b >> a.txt; git commit -qam c2
git switch -qc side; echo s > s.txt; git add -A; git commit -qm side1; git switch -q main
git merge -q --no-ff side -m "merge side"
git remote add origin ../origin.git; git push -q -u origin main
git worktree add -q -b wt-one ../demo-one
git worktree add -q -b wt-two ../demo-two
git init -q nested-repo   # 중첩 저장소 (status 에 "nested-repo/")
cd "$R"

echo "── A. 저장소 인식"
js "await window.__TAURI_INTERNALS__.invoke('repo_add', {path: '$R/demo'}); await window.__aitermStore.getState().refreshRepos(); window.__aitermStore.getState().setFocusWorktree('$R/demo'); await new Promise(r => setTimeout(r, 1000)); document.querySelector('.tabs [data-tab=graph]')?.click(); await new Promise(r => setTimeout(r, 800)); return 'ok'" >/dev/null
APP_WT=$(js "const r = window.__aitermStore.getState().repos.find(r => r.id === '$R/demo/.git'); return r.worktrees.map(w => w.path + ' ' + w.branch + ' ' + w.head).join('|')")
CLI_WT=$(git -C "$R/demo" worktree list --porcelain | awk '/^worktree/{p=$2} /^HEAD/{h=$2} /^branch/{sub("refs/heads/","",$2); print p" "$2" "h}' | paste -sd'|' -)
check "워크트리 목록 = git worktree list" "$APP_WT" "$CLI_WT"
APP_LOG=$(js "return [...document.querySelectorAll('.grow')].map(r => r.dataset.sha).join(' ')")
CLI_LOG=$(git -C "$R/demo" log --topo-order --format=%H --branches --remotes --tags | paste -sd' ' -)
check "그래프 순서 = git log --topo-order" "$APP_LOG" "$CLI_LOG"
check "현재 브랜치" "$(js "return document.querySelector('[data-testid=git-current-branch]').innerText")" "main"

echo "── D. 워크트리 전환은 조회만"
BEFORE=$(for w in demo demo-one demo-two; do git -C "$R/$w" rev-parse --abbrev-ref HEAD; done | paste -sd, -)
for w in demo-one demo-two demo; do
  js "window.__aitermStore.getState().setFocusWorktree('$R/$w'); await new Promise(r => setTimeout(r, 900)); return 1" >/dev/null
  case $w in demo-one) exp=wt-one;; demo-two) exp=wt-two;; *) exp=main;; esac
  check "$w 를 보면 Git 패널 = $exp" "$(js "return document.querySelector('[data-testid=git-current-branch]').innerText")" "$exp"
  check "$w 를 보면 파일 트리 루트 = $w" "$(js "return document.querySelector('.tree-wrap .filters .path-text').innerText")" "$w"
done
AFTER=$(for w in demo demo-one demo-two; do git -C "$R/$w" rev-parse --abbrev-ref HEAD; done | paste -sd, -)
check "전환 후 모든 워크트리 HEAD 그대로" "$AFTER" "$BEFORE"

echo "── E. 외부 변경 감지"
printf 'x' > "$R/demo/foo[1].txt"; printf 'y' > "$R/demo/foo1.txt"; printf 'z' > "$R/demo/ lead.txt"; echo c >> "$R/demo/a.txt"
sleep 1.5
APP_ST=$(js "await new Promise(r => setTimeout(r, 300)); const t = [...document.querySelectorAll('.tabs button')].find(b => b.innerText.startsWith('변경 사항')); return t.querySelector('.count')?.innerText ?? '0'")
CLI_ST=$(git -C "$R/demo" status --porcelain -uall | wc -l | tr -d ' ')
check "변경 수 = git status" "$APP_ST" "$CLI_ST"
check "a.txt 에 수정 표시" "$(js "return document.querySelector('.tree-row[data-rel=\"a.txt\"] .kind')?.innerText ?? ''")" "M"
check "앞 공백 파일명 유지" "$(js "return document.querySelector('.tree-row[data-rel=\" lead.txt\"]') ? 'yes' : 'no'")" "yes"

echo "── 보안: 등록되지 않은 경로 거부"
# 인자 객체의 중괄호가 bash 중괄호 확장으로 쪼개지지 않게 JS 를 파일로 넘긴다.
deny() { # 이름 명령 JSON인자
  local f; f=$(mktemp)
  printf '%s' "try { await window.__TAURI_INTERNALS__.invoke('$2', $3); return 'allowed' } catch (e) { return 'denied' }" > "$f"
  check "$1" "$(python3 "$EVAL" -f "$f")" "denied"; rm -f "$f"
}
deny "fs_read(/etc/hosts) 거부" fs_read '{"worktree": "/etc", "rel": "hosts"}'
deny "git_status(홈) 거부" git_status "{\"path\": \"$HOME\"}"
deny "워크트리 밖 rel 거부" fs_read "{\"worktree\": \"$R/demo\", \"rel\": \"../demo-one/a.txt\"}"
deny "등록 안 된 폴더 Finder 열기 거부" reveal_in_finder '{"path": "/etc"}'

echo "── 커밋: 스테이지한 파일만 / 중첩 저장소 제외"
cat > /tmp/aiterm-reg-commit.js <<'JS'
const wait = (ms) => new Promise(r => setTimeout(r, ms));
document.querySelector('.tabs [data-tab=changes]').click(); await wait(700);
const row = (p) => document.querySelector(`[data-testid=unstaged-list] li[data-path="${p}"]`);
row('foo[1].txt').querySelector('button[aria-label$="스테이지"]').click(); await wait(900);
const ta = document.querySelector('.commit-box textarea');
Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'foo[1] 만');
ta.dispatchEvent(new Event('input', {bubbles: true})); await wait(200);
document.querySelector('[data-testid=commit-btn]').click(); await wait(2000);
return 1;
JS
python3 "$EVAL" -f /tmp/aiterm-reg-commit.js >/dev/null
check "커밋된 파일 = foo[1].txt 하나" "$(git -C "$R/demo" show --name-only --format= HEAD | paste -sd, -)" "foo[1].txt"
check "중첩 저장소에는 스테이지 버튼 없음" "$(js "const li = document.querySelector('[data-testid=unstaged-list] li[data-path=\"nested-repo/\"]'); return li ? String(!li.querySelector('button[aria-label\$=\"스테이지\"]')) : 'missing'")" "true"

echo "── F. 외부 브랜치 변경"
git -C "$R/demo-one" switch -qc wt-one-v2
js "window.__aitermStore.getState().setFocusWorktree('$R/demo-one'); await new Promise(r => setTimeout(r, 1500)); return 1" >/dev/null
check "외부 브랜치 변경 반영" "$(js "return document.querySelector('[data-testid=git-current-branch]').innerText")" "wt-one-v2"

echo
echo "결과: 통과 $PASS / 실패 $FAIL"
[ "$FAIL" -eq 0 ]
