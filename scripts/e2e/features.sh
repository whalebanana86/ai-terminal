#!/bin/bash
# 브랜치 체크아웃·워크트리 생성/삭제·hunk 스테이징·병합 충돌 해결·rebase 를 실제 버튼으로 검증한다.
# 실행 중인 automation 빌드가 필요하다. 테스트 저장소는 /private/tmp/aiterm-e2e-feat 에 새로 만든다.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
EVAL="$HERE/../aiterm-eval.py"
R=/private/tmp/aiterm-e2e-feat
PASS=0; FAIL=0
ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (앱/실제: '$2' / 기대: '$3')"; fi; }
G() { git -C "$1" "${@:2}"; }

# 화면 조작 도우미(JS). 각 단계 스크립트 앞에 붙인다.
read -r -d '' HELPERS <<'JS' || true
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const S = window.__aitermStore; const st = () => S.getState();
async function until(f, ms = 5000) { for (let i = 0; i < ms / 100; i++) { const v = f(); if (v) return v; await wait(100); } throw new Error('timeout waiting'); }
function btn(text, root = document) { return [...root.querySelectorAll('button')].find(b => b.innerText.trim() === text || b.innerText.trim().startsWith(text)); }
async function confirmDialog(label) { const b = await until(() => btn(label, document.querySelector('.modal') ?? document.createElement('div'))); b.click(); await wait(400); }
async function fillPrompt(values, label) {
  const m = await until(() => document.querySelector('form.modal'));
  for (const [i, v] of Object.entries(values)) {
    const el = m.querySelectorAll('input.text-input, select')[i];
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  }
  await wait(150);
  btn(label, m).click(); await wait(300);
}
async function tab(name) { document.querySelector(`.tabs [data-tab=${name}]`).click(); await wait(500); }
async function focus(path) { st().setFocusWorktree(path); await wait(1200); }
JS
js() { local f; f=$(mktemp); printf '%s\n%s' "$HELPERS" "$1" > "$f"; AITERM_EVAL_TIMEOUT_MS=120000 python3 "$EVAL" -f "$f"; rm -f "$f"; }

echo "── 준비"
rm -rf "$R"; mkdir -p "$R"; cd "$R"
git init -q -b main demo; cd demo
git config user.name feat; git config user.email feat@local
for i in $(seq 1 40); do echo "line $i"; done > big.txt; echo x > x.txt
git add -A; git commit -qm base
git branch side
git worktree add -q -b two ../demo-two
cd "$R"
js "await window.__TAURI_INTERNALS__.invoke('repo_add', {path: '$R/demo'}); await st().refreshRepos(); await focus('$R/demo-two'); await tab('graph'); return 1" >/dev/null

echo "── 1. 브랜치 전환 메뉴로 체크아웃"
js "document.querySelector('[data-testid=git-current-branch]').click(); await wait(300);
    [...document.querySelectorAll('.switcher-item')].find(b => b.innerText.includes('side')).click();
    await confirmDialog('전환'); await wait(1200); return 1" >/dev/null
check "demo-two 가 side 로 체크아웃됨" "$(G "$R/demo-two" rev-parse --abbrev-ref HEAD)" "side"
check "Git 패널도 side" "$(js "return document.querySelector('[data-testid=git-current-branch]').innerText")" "side"
js "document.querySelector('[data-testid=git-current-branch]').click(); await wait(300);
    [...document.querySelectorAll('.switcher-item')].find(b => b.innerText.startsWith('main')).click();
    await confirmDialog('그 폴더 열기'); await wait(1200); return 1" >/dev/null
check "main 은 다른 워크트리 사용 중 → 그 워크트리로 화면 이동" "$(js "return st().focus.worktreePath")" "$R/demo"
check "그동안 demo-two HEAD 는 그대로" "$(G "$R/demo-two" rev-parse --abbrev-ref HEAD)" "side"

echo "── 2. 브랜치 탭에서 새 브랜치"
js "await tab('branches'); btn('새 브랜치', document.querySelector('.branches')).click(); await fillPrompt({0: 'feat/new'}, '만들기'); await wait(1000); return 1" >/dev/null
check "feat/new 생성(체크아웃 안 함)" "$(G "$R/demo" branch --list feat/new | tr -d ' *')" "feat/new"
check "현재 브랜치는 그대로 main" "$(G "$R/demo" rev-parse --abbrev-ref HEAD)" "main"

echo "── 3. 그래프 우클릭 → 새 워크트리, 워크트리 탭에서 삭제"
js "await tab('graph'); const row = document.querySelector('.grow');
    row.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: 200, clientY: 200})); await wait(300);
    [...document.querySelectorAll('.menu-item')].find(b => b.innerText.startsWith('여기서 새 워크트리')).click();
    await fillPrompt({0: 'agent/task-1', 1: '$R/demo-task1'}, '만들기'); await wait(1500); return 1" >/dev/null
check "새 워크트리가 git 에 등록됨" "$(G "$R/demo" worktree list | grep -c demo-task1)" "1"
check "새 워크트리 브랜치" "$(G "$R/demo-task1" rev-parse --abbrev-ref HEAD)" "agent/task-1"
check "만든 워크트리로 화면 이동" "$(js "return st().focus.worktreePath")" "$R/demo-task1"
echo dirty > "$R/demo-task1/dirty.txt"
js "await tab('worktrees'); const li = document.querySelector('.wt-list li[data-wt=\"$R/demo-task1\"]'); li.querySelector('[data-action=wt-menu]').click(); await wait(300); document.querySelector('.menu [data-action=wt-delete]').click(); await wait(400);
    const m = document.querySelector('form.modal'); const boxes = m.querySelectorAll('input[type=checkbox]');
    btn('삭제', m).click(); await wait(300);
    const blocked = !!document.querySelector('form.modal .banner-error');
    boxes[0].click(); boxes[1].click(); await wait(100); btn('삭제', m).click(); await wait(2000);
    return blocked" > /tmp/aiterm-feat-blocked.txt
check "변경 있는 워크트리는 동의 없이 삭제 안 됨" "$(cat /tmp/aiterm-feat-blocked.txt)" "true"
check "동의 후 워크트리 삭제" "$(G "$R/demo" worktree list | grep -c demo-task1 || true)" "0"
check "브랜치도 함께 삭제(병합됨)" "$(G "$R/demo" branch --list agent/task-1 | wc -l | tr -d ' ')" "0"

echo "── 4. hunk 단위 스테이징"
sed -i '' -e 's/^line 2$/line 2 changed/' -e 's/^line 38$/line 38 changed/' "$R/demo/big.txt"
js "await focus('$R/demo'); await tab('changes'); document.querySelector('[data-testid=unstaged-list] li[data-path=\"big.txt\"] .path').click(); await wait(1200);
    const sv = await until(() => document.querySelector('[data-testid=stage-view]'));
    const hunks = sv.querySelectorAll('[data-side=unstaged] .hunk'); hunks[1].querySelector('[data-action=stage-hunk]').click(); await wait(1200);
    return document.querySelectorAll('[data-side=unstaged] .hunk').length + ',' + document.querySelectorAll('[data-side=staged] .hunk').length" > /tmp/aiterm-feat-hunks.txt
check "두 번째 hunk 만 스테이지됨 (화면 미스테이지1,스테이지1)" "$(cat /tmp/aiterm-feat-hunks.txt)" "1,1"
check "index 에는 line 38 변경만" "$(G "$R/demo" diff --cached | grep -c '^+line' )" "1"
check "index 의 변경 = line 38" "$(G "$R/demo" diff --cached | grep '^+line')" "+line 38 changed"
js "document.querySelector('[data-side=unstaged] .hunk').querySelector('button').click(); await confirmDialog('버리기'); await wait(1000); return 1" >/dev/null
check "첫 hunk 버림 → 워크트리에서 line 2 원래대로" "$(grep -c '^line 2$' "$R/demo/big.txt")" "1"
js "document.querySelector('[data-side=staged] [data-action=unstage-hunk]').click(); await wait(1000); return 1" >/dev/null
check "스테이지 취소 → index 비어 있음" "$(G "$R/demo" diff --cached | wc -l | tr -d ' ')" "0"
G "$R/demo" checkout -q -- big.txt

echo "── 5. 병합 충돌 해결"
G "$R/demo" switch -q -c conf; echo conf-side > "$R/demo/x.txt"; G "$R/demo" commit -qam "conf x"; G "$R/demo" switch -q main
echo main-side > "$R/demo/x.txt"; G "$R/demo" commit -qam "main x"
js "await focus('$R/demo'); await tab('branches'); const li = document.querySelector('.branch-list li[data-ref=conf]');
    li.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: 200, clientY: 200})); await wait(300);
    [...document.querySelectorAll('.menu-item')].find(b => b.innerText.includes('에 병합')).click();
    await fillPrompt({0: 'no-ff'}, '병합'); await wait(2000);
    const ob = await until(() => document.querySelector('[data-testid=op-banner]'));
    return ob.innerText.includes('x.txt') ? 'conflict-shown' : ob.innerText" > /tmp/aiterm-feat-merge.txt
check "충돌 배너에 x.txt" "$(cat /tmp/aiterm-feat-merge.txt)" "conflict-shown"
check "실제로 MERGE 진행 중" "$(test -f "$R/demo/.git/MERGE_HEAD" && echo yes)" "yes"
js "const li = [...document.querySelectorAll('.conflicts li')].find(l => l.innerText.includes('x.txt')); btn('가져오는 쪽', li).click(); await wait(1500);
    btn('계속', document.querySelector('[data-testid=op-banner]')).click(); await wait(2000); return 1" >/dev/null
check "병합 커밋(부모 2개) 생성" "$(G "$R/demo" rev-list --parents -n1 HEAD | wc -w | tr -d ' ')" "3"
check "가져오는 쪽 내용으로 해결" "$(cat "$R/demo/x.txt")" "conf-side"
check "진행 배너 사라짐" "$(js "return String(!document.querySelector('[data-testid=op-banner]'))")" "true"

echo "── 6. rebase (그래프 메뉴)"
G "$R/demo" switch -q -c topic HEAD~1 2>/dev/null || G "$R/demo" switch -q -c topic
echo t > "$R/demo/t.txt"; G "$R/demo" add t.txt; G "$R/demo" commit -qm topic-commit
js "await focus('$R/demo'); await tab('graph'); const row = [...document.querySelectorAll('.grow')].find(r => r.innerText.includes('main') && r.querySelector('.ref-branch'));
    row.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: 200, clientY: 200})); await wait(300);
    [...document.querySelectorAll('.menu-item')].find(b => b.innerText.includes(\"이 위로 리베이스\")).click();
    await confirmDialog('리베이스'); await wait(2500); return 1" >/dev/null
check "topic 이 main 위로 올라감 (main 이 조상)" "$(G "$R/demo" merge-base --is-ancestor main topic && echo yes)" "yes"
check "topic 커밋 1개 유지" "$(G "$R/demo" rev-list --count main..topic)" "1"

echo
echo "결과: 통과 $PASS / 실패 $FAIL"
[ "$FAIL" -eq 0 ]
