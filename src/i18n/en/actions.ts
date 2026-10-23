/** 영어 사전: actions (gitActions.ts 확인창·알림, logic.ts 꼬리표, store.ts 알림) */
export default {
  // gitActions.ts — 공통 알림
  "{label} 완료": "{label} — done",
  "{label} 실패: {error}": "{label} failed: {error}",

  // gitActions.ts — 체크아웃
  "{branch} 은(는) 다른 워크트리에서 쓰는 중": "{branch} is in use in another worktree",
  "Git 은 한 브랜치를 두 워크트리에서 동시에 열 수 없어요.\n{path}\n\n그 워크트리를 대신 볼까요? (화면만 옮기고 체크아웃하지 않아요)":
    "Git can't open one branch in two worktrees at once.\n{path}\n\nShow that worktree instead? (Only the view moves; nothing is checked out.)",
  "그 워크트리 보기": "Show that worktree",
  "커밋으로 이동 (브랜치 없음 상태)": "Go to commit (no branch)",
  "{branch} 로 전환 (체크아웃)": "Switch to {branch} (check out)",
  "워크트리 {worktree} 를 커밋 {commit} (브랜치 없음 상태) 로 바꿉니다.": "Switches worktree {worktree} to commit {commit} (no branch).",
  "워크트리 {worktree} 를 {branch} 로 바꿉니다.": "Switches worktree {worktree} to {branch}.",
  "로컬 브랜치가 없으면 {remote} 를 추적하는 '{branch}' 을 만듭니다.": "If there's no local branch, creates '{branch}' tracking {remote}.",
  "워크트리 안의 파일이 그 브랜치 내용으로 바뀌어요.": "Files in the worktree will change to match that branch.",
  전환: "Switch",

  // gitActions.ts — 새 워크트리
  "'{branch}' 을(를) 새 워크트리로 열기": "Open '{branch}' in a new worktree",
  "새 워크트리": "New worktree",
  "지금 워크트리는 그대로 두고, 새 워크트리(별도 폴더)에서 이 브랜치를 엽니다.":
    "Opens this branch in a new worktree (a separate folder). The current worktree stays as it is.",
  "{base} 에서 새 브랜치를 만들어 새 워크트리(별도 폴더)에서 엽니다. 지금 워크트리는 바뀌지 않습니다.":
    "Creates a new branch from {base} and opens it in a new worktree (a separate folder). The current worktree doesn't change.",
  "새 브랜치 이름": "New branch name",
  "폴더 위치": "Folder location",
  만들기: "Create",
  "브랜치 이름을 입력하세요": "Enter a branch name",
  "절대 경로를 입력하세요": "Enter an absolute path",
  "워크트리 만들기": "Create worktree",

  // gitActions.ts — 워크트리 삭제·정리
  "메인 워크트리는 지울 수 없습니다": "The main worktree can't be deleted",
  "사라진 워크트리 정리": "Prune missing worktree",
  "{path}\n폴더가 없습니다. 워크트리 등록을 정리합니다(git worktree prune).":
    "{path}\nThe folder no longer exists. This prunes the worktree registration (git worktree prune).",
  "정리|워크트리": "Prune",
  "워크트리 정리": "Prune worktree",
  "워크트리 삭제: {name}": "Delete worktree: {name}",
  "{path}\n폴더를 지우고 워크트리 등록을 해제합니다. 브랜치 '{branch}' 의 커밋은 남아요.":
    "{path}\nDeletes the folder and unregisters the worktree. Commits on branch '{branch}' are kept.",
  "(브랜치 없음)": "(no branch)",
  "커밋하지 않은 변경 {n}개가 있습니다. 지우면 되돌릴 수 없습니다.": "There are uncommitted changes ({n}). Deleting can't be undone.",
  "이 워크트리에서 에이전트 {n}개가 실행 중입니다.": "Agents running in this worktree: {n}.",
  "변경 {n}개를 버리고 삭제": "Discard changes ({n}) and delete",
  "브랜치 '{branch}' 도 삭제 (병합된 경우만)": "Also delete branch '{branch}' (only if merged)",
  삭제: "Delete",
  "변경을 버리는 데 동의해야 삭제할 수 있습니다": "Agree to discard the changes to delete",
  "외부 에이전트가 실행 중": "External agents running",
  "이 워크트리에서 앱 밖의 에이전트 {n}개가 실행 중입니다. 폴더를 지우면 그 에이전트가 하던 작업이 깨집니다.\n그래도 삭제할까요?":
    "Agents outside the app are running in this worktree ({n}). Deleting the folder will break their work.\nDelete anyway?",
  "그래도 삭제": "Delete anyway",
  "워크트리 삭제": "Delete worktree",

  // gitActions.ts — 브랜치 만들기·삭제
  "새 브랜치": "New branch",
  "{start} 에서 시작합니다.": "Starts from {start}.",
  "브랜치 이름": "Branch name",
  "만든 뒤 지금 워크트리를 이 브랜치로 전환": "Switch the current worktree to this branch after creating it",
  "이름을 입력하세요": "Enter a name",
  "체크아웃 확인": "Confirm check out",
  "만들고 체크아웃": "Create and check out",
  "브랜치 만들기": "Create branch",
  "브랜치 '{branch}' 삭제": "Delete branch '{branch}'",
  "병합된 브랜치만 지웁니다(git branch -d). 병합되지 않은 커밋이 있으면 Git 이 거부합니다.":
    "Deletes the branch only if it's merged (git branch -d). Git refuses if it has unmerged commits.",
  "브랜치 삭제": "Delete branch",

  // gitActions.ts — 병합
  "브랜치가 없는 상태에서는 병합할 수 없어요. 먼저 브랜치로 전환하세요.": "Can't merge with no branch checked out. Switch to a branch first.",
  "'{target}' 의 커밋이 이미 '{current}' 에 모두 들어 있습니다": "All commits from '{target}' are already in '{current}'",
  "{target} → {current} 병합": "Merge {target} → {current}",
  "{target} 에만 있는 커밋 {n}개를 {current} 로 가져옵니다.": "Brings the commits that are only on {target} ({n}) into {current}.",
  "지금은 병합 커밋 없이 앞으로 이동만 하면 됩니다.": "Right now a fast-forward is enough; no merge commit is needed.",
  "충돌이 나면 멈추고, 해결한 뒤 계속하거나 중단할 수 있습니다.": "If there's a conflict, it stops so you can resolve it and then continue or abort.",
  방식: "Mode",
  "가능하면 그냥 앞으로 이동 (기본, fast-forward)": "Fast-forward when possible (default)",
  "항상 병합 커밋 만들기 (--no-ff)": "Always create a merge commit (--no-ff)",
  "앞으로 이동만, 안 되면 취소 (--ff-only)": "Fast-forward only, otherwise cancel (--ff-only)",
  병합: "Merge",
  "충돌이 생겼습니다. Git 패널 위쪽에서 파일별로 해결한 뒤 '계속'을 누르세요.":
    "There are conflicts. Resolve each file at the top of the Git panel, then click 'Continue'.",

  // gitActions.ts — 리베이스
  "브랜치가 없는 상태에서는 리베이스할 수 없어요.": "Can't rebase with no branch checked out.",
  "'{current}' 은(는) 이미 '{onto}' 위에 있습니다": "'{current}' is already on top of '{onto}'",
  "{current} 를 {onto} 위로 리베이스": "Rebase {current} onto {onto}",
  "{current} 에만 있는 커밋 {ahead}개를 {onto} 의 최신 커밋({behind}개 앞) 위에 다시 씁니다. 커밋 해시가 바뀝니다.":
    "Rewrites the commits that are only on {current} ({ahead}) on top of the latest commit of {onto} ({behind} ahead). Commit hashes will change.",
  "이미 {upstream} 에 push 한 커밋도 다시 쓰게 됩니다. 이후 push 에는 강제 푸시가 필요하고, 다른 사람의 작업과 충돌할 수 있습니다.":
    "This also rewrites commits already pushed to {upstream}. Later pushes will need a force push and may conflict with other people's work.",
  리베이스: "Rebase",
  "리베이스 중 충돌이 생겼어요. Git 패널 위쪽에서 해결한 뒤 '계속', 건너뛰려면 '건너뛰기', 원래대로 하려면 '중단'.":
    "Conflicts during rebase. Resolve them at the top of the Git panel, then click 'Continue', or 'Skip' to skip, or 'Abort' to go back.",

  // logic.ts — 브랜치·세션 이름
  "브랜치 없음|브랜치 이름 자리": "No branch",
  "새 Claude 세션": "New Claude session",
  "새 Codex 세션": "New Codex session",

  // logic.ts — 실행 위치(clientLabel)
  터미널: "Terminal",
  "SDK/다른 앱": "SDK/other app",
  "Codex 앱 서버": "Codex app server",

  // logic.ts — 상대 시간
  방금: "just now",
  "{n}분 전": "{n} min ago",
  "{n}시간 전": "{n}h ago",
  "{n}일 전": "{n}d ago",

  // logic.ts — 변경 종류(kindLabel). 버튼의 "수정"·"추가"·"삭제" 와 영어가 달라 맥락을 붙인다.
  "수정|파일 상태": "Modified",
  "추가|파일 상태": "Added",
  "삭제|파일 상태": "Deleted",
  "이름 변경|파일 상태": "Renamed",
  "새 파일|파일 상태": "New file",
  "충돌|파일 상태": "Conflicted",

  // logic.ts — 체크아웃 경고
  "이 워크트리에 커밋하지 않은 변경 {n}개가 있어요. 충돌하지 않는 변경은 '{target}' 으로 함께 옮겨집니다.":
    "This worktree has uncommitted changes ({n}). Changes that don't conflict will carry over to '{target}'.",
  "이 워크트리에서 일하는 에이전트가 {n}개 있어요. 브랜치를 바꾸면 에이전트가 갑자기 다른 파일을 보게 됩니다.":
    "Agents working in this worktree: {n}. Switching branches will suddenly show them different files.",

  // store.ts — 알림
  "저장소 목록을 읽지 못했습니다: {error}": "Couldn't load the repository list: {error}",
  "세션 목록을 읽지 못했습니다: {error}": "Couldn't load the session list: {error}",
} satisfies Record<string, string>;
