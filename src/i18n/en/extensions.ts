/** 영어 사전: 확장 기능(설정 → 기능, 파일 편집, 외부 편집기, 내 수정 워크트리)과 Git 시작 */
export default {
  // 설정
  기능: "Features",
  "외부 편집기": "External editor",
  "자동 (설치된 편집기)": "Automatic (installed editor)",
  "파일 편집": "File editing",
  "파일 보기에 '편집' 탭을 더해요. 켜면 앱이 워크트리 안 파일을 저장할 수 있어요.": "Adds an 'Edit' tab to the file viewer. When on, the app can save files inside your worktrees.",
  스틱맨: "Stickman",
  "위쪽 막대 오른쪽에서 요청 종류마다 동작하고 오늘 요청 수를 세요.": "Acts out each kind of request at the right of the top bar and counts today's requests.",
  "구독 한도 표시": "Subscription limits",
  "아래 상태줄에 Claude·Codex 의 5시간·주간 한도 사용률을 보여 줘요. 끄면 로그인 정보를 읽지 않아요.":
    "Shows Claude and Codex 5-hour and weekly limit usage in the status bar. When off, login details aren't read.",
  // 파일 보기
  편집: "Edit",
  "이 파일을 앱에서 고치기 (⌘S 저장)": "Edit this file in the app (⌘S to save)",
  "외부 편집기로 열기": "Open in external editor",
  "외부 편집기로 열지 못했어요: {error}": "Couldn't open in the external editor: {error}",
  // 편집 화면
  "이 파일은 앱에서 고칠 수 없어요": "This file can't be edited in the app",
  "저장하지 못했어요: {error}": "Couldn't save: {error}",
  "저장하지 않았어요. 불러온 뒤 밖(AI·다른 편집기)에서 이 파일이 바뀌었어요.": "Not saved. This file was changed outside (by an AI or another editor) after you opened it.",
  "밖(AI·다른 편집기)에서 이 파일이 바뀌었어요. 내 수정은 아직 그대로예요.": "This file was changed outside (by an AI or another editor). Your edits are still here.",
  "다시 불러오기 (내 수정 버림)": "Reload (discard my edits)",
  "내 것으로 덮어쓰기": "Overwrite with mine",
  "저장하지 않은 수정을 이어서 보여 줘요.": "Showing your unsaved edits.",
  "수정 버리기": "Discard edits",
  "저장 중…": "Saving…",
  "저장 안 됨": "Unsaved",
  저장했어요: "Saved",
  "고칠 수 있어요": "Editable",
  "⌘F 찾기 · Esc 나가기": "⌘F find · Esc leave",
  "저장 (⌘S)": "Save (⌘S)",
  저장: "Save",
  // 내 수정 워크트리
  "이 워크트리에서 AI 가 {n}개 일하는 중이에요. 같은 파일을 고치면 서로 덮어쓸 수 있어요.": "{n} AI agent(s) are working in this worktree. Editing the same file can overwrite each other's changes.",
  "내 수정 워크트리에서 고치기": "Edit in my own worktree",
  "여기서 그냥 고치기": "Edit here anyway",
  "내 수정 워크트리예요. AI 가 아직 커밋하지 않은 변경은 여기 없어요. 고친 뒤 커밋하고 합치세요.":
    "This is your edit worktree. Changes the AI hasn't committed yet aren't here. Commit your edits, then merge.",
  "AI 브랜치에 합치기": "Merge into AI branch",
  "브랜치가 없는 상태(detached)의 워크트리에서는 내 수정 워크트리를 만들 수 없어요": "Can't make an edit worktree from a detached worktree",
  "내 수정 워크트리에서 고칠까요?": "Edit in your own worktree?",
  "AI 가 일하는 {worktree} ({branch}) 는 그대로 두고, 옆 폴더에 '{edit}' 브랜치로 내 수정 워크트리를 열어요(이미 있으면 그걸 써요).\n\nAI 가 아직 커밋하지 않은 변경은 내 수정 워크트리에 없어요. 다 고치면 커밋한 뒤 'AI 브랜치에 합치기'로 합쳐요.":
    "{worktree} ({branch}), where the AI works, stays as it is. Your edit worktree opens in a folder next to it on the '{edit}' branch (an existing one is reused).\n\nChanges the AI hasn't committed yet aren't in your edit worktree. When you're done, commit and use 'Merge into AI branch'.",
  "내 수정 워크트리를 열었어요: {path}": "Opened your edit worktree: {path}",
  "내 수정 워크트리를 열지 못했어요: {error}": "Couldn't open your edit worktree: {error}",
  "커밋하지 않은 수정이 {n}개 있어요. Git 패널 → 변경 사항에서 먼저 커밋하세요.": "{n} edit(s) aren't committed. Commit them first in Git → Changes.",
  "'{branch}' 브랜치를 쓰는 워크트리가 없어 합칠 곳이 없어요": "No worktree uses the '{branch}' branch, so there's nowhere to merge",
  // Git 이 아닌 폴더
  "저장소로 쓸 폴더 선택": "Choose a folder to use as a repository",
  "Git 저장소가 아닙니다: {reason}": "Not a Git repository: {reason}",
  "Git 저장소가 아닌 폴더예요": "This folder isn't a Git repository",
  "{path}\n\n이 폴더에서 Git 을 시작할까요? (git init)\n파일은 그대로 두고 .git 폴더만 만들어요. 커밋은 하지 않으니 Git 패널에서 담을 파일을 고른 뒤 첫 커밋을 하세요.":
    "{path}\n\nStart Git in this folder? (git init)\nYour files stay as they are; only a .git folder is created. Nothing is committed, so pick the files in the Git panel and make the first commit.",
  "Git 시작하고 추가": "Start Git and add",
};
