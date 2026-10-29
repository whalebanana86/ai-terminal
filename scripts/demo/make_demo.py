#!/usr/bin/env python3
"""README 그림·시연 영상용 지어낸 예시 데이터를 만든다.

  python3 scripts/demo/make_demo.py <폴더>
  DEMO_LANG=en python3 scripts/demo/make_demo.py <폴더>   # 영어 예시(커밋·세션 대화)

<폴더>/work/todo-app          할 일 앱 저장소(메인 워크트리) + 원격(<폴더>/remote/todo-app.git)
<폴더>/work/todo-app-login    워크트리 (agent/login)
<폴더>/work/todo-app-darkmode 워크트리 (agent/dark-mode)
<폴더>/home/.claude, .codex   가짜 Claude Code·Codex 세션 기록 (앱은 AITERM_HOME 으로 이 폴더를 HOME 처럼 읽는다)

실제 사용자 기록·저장소는 건드리지 않는다. 시각은 지금을 기준으로 정해서 "오늘·어제·이번 주" 묶음이 자연스럽게 나온다.
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid
import zlib
import struct
import math
from datetime import datetime, timezone

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "/tmp/aiterm-demo")
WORK = os.path.join(ROOT, "work")
HOME = os.path.join(ROOT, "home")
MAIN = os.path.join(WORK, "todo-app")
LOGIN = os.path.join(WORK, "todo-app-login")
DARK = os.path.join(WORK, "todo-app-darkmode")
NOW = time.time()
MIN, HOUR, DAY = 60, 3600, 86400
EN = os.environ.get("DEMO_LANG") == "en"


def t(ko, en):
    return en if EN else ko


MINA = ("Mina Kim", "mina@example.com")
JUN = ("Jun Park", "jun@example.com")


def git(cwd, *args, when=None, who=MINA):
    env = dict(os.environ)
    env.update(
        GIT_AUTHOR_NAME=who[0], GIT_AUTHOR_EMAIL=who[1], GIT_COMMITTER_NAME=who[0], GIT_COMMITTER_EMAIL=who[1],
        GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1",
    )
    if when is not None:
        stamp = f"@{int(when)} +0900"
        env.update(GIT_AUTHOR_DATE=stamp, GIT_COMMITTER_DATE=stamp)
    return subprocess.run(["git", "-C", cwd, *args], env=env, check=True, capture_output=True, text=True).stdout.strip()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


# 에이전트와 함께 쓴 커밋의 공동 작성자 트레일러(그래프의 🤖 표시)
CLAUDE = "Claude <noreply@anthropic.com>"
CODEX = "Codex <noreply@openai.com>"


def commit(cwd, msg, ago, files, who=MINA, ai=None):
    for p, t in files.items():
        write(os.path.join(cwd, p), t)
    git(cwd, "add", "-A")
    if ai:
        msg = f"{msg}\n\nCo-Authored-By: {ai}"
    git(cwd, "commit", "-q", "-m", msg, when=NOW - ago, who=who)


SORT_V1 = """export type Todo = { id: string; title: string; done: boolean; due?: string; tags: string[] };

export function sortTodos(list: Todo[]): Todo[] {
  return [...list].sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));
}
"""
SORT_V2_DOC = t("/** 안 끝난 일 먼저, 그다음 마감일이 가까운 순 */\n", "/** Open todos first, then the nearest due date */\n")
SORT_V2 = """export type Todo = { id: string; title: string; done: boolean; due?: string; tags: string[] };

""" + SORT_V2_DOC + """export function sortTodos(list: Todo[]): Todo[] {
  return [...list].sort((a, b) => Number(a.done) - Number(b.done) || (a.due ?? "9999").localeCompare(b.due ?? "9999"));
}

export function byTag(list: Todo[], tag: string | null): Todo[] {
  return tag ? list.filter((t) => t.tags.includes(tag)) : list;
}
"""
SORT_WORKING = """export type Todo = { id: string; title: string; done: boolean; due?: string; tags: string[]; pinned?: boolean };

""" + t("/** 고정한 일 → 안 끝난 일 → 마감일이 가까운 순 */", "/** Pinned → open → nearest due date */") + """
export function sortTodos(list: Todo[]): Todo[] {
  return [...list].sort(
    (a, b) =>
      Number(!!b.pinned) - Number(!!a.pinned) ||
      Number(a.done) - Number(b.done) ||
      (a.due ?? "9999").localeCompare(b.due ?? "9999"),
  );
}

export function byTag(list: Todo[], tag: string | null): Todo[] {
  return tag ? list.filter((t) => t.tags.includes(tag.toLowerCase())) : list;
}
"""
CSS = """:root {
  --bg: #ffffff;
  --fg: #1d1d1f;
  --accent: #3478f6;
}
body { margin: 0; font: 15px/1.5 system-ui; background: var(--bg); color: var(--fg); }
.todo { display: flex; gap: 8px; padding: 8px 12px; }
.todo.done { opacity: 0.5; text-decoration: line-through; }
"""


def png(path, draw, size=256):
    """의존성 없이 작은 PNG(RGBA)를 만든다. draw(x, y) → (r, g, b, a)"""
    raw = b"".join(b"\x00" + b"".join(bytes(draw(x, y)) for x in range(size)) for y in range(size))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def logo(color, check):
    """둥근 사각형 바탕 + 체크 표시(check=True) 또는 점 세 개"""
    def draw(x, y):
        cx, cy = x - 128, y - 128
        r = 96
        inside = max(abs(cx) - r + 28, 0) ** 2 + max(abs(cy) - r + 28, 0) ** 2 <= 28 ** 2
        if not inside:
            return (0, 0, 0, 0)
        if check:
            def seg(ax, ay, bx, by):
                t = max(0.0, min(1.0, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)))
                return math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)))
            if min(seg(84, 130, 114, 160), seg(114, 160, 174, 98)) < 12:
                return (255, 255, 255, 255)
        else:
            for dx in (-48, 0, 48):
                if (cx - dx) ** 2 + cy ** 2 < 15 ** 2:
                    return (255, 255, 255, 255)
        return (*color, 255)
    return draw


def make_repo():
    shutil.rmtree(ROOT, ignore_errors=True)
    os.makedirs(WORK)
    os.makedirs(os.path.join(ROOT, "remote"))
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", os.path.join(ROOT, "remote", "todo-app.git")], check=True)
    subprocess.run(["git", "init", "-q", "-b", "main", MAIN], check=True)
    git(MAIN, "config", "user.name", MINA[0])
    git(MAIN, "config", "user.email", MINA[1])
    readme = t("# 할 일 앱\n\n작은 할 일 목록 앱.\n", "# Todo app\n\nA small to-do list app.\n")
    commit(MAIN, t("프로젝트 시작: Vite + React", "Start project: Vite + React"), 6 * DAY, {
        "README.md": readme,
        "package.json": '{\n  "name": "todo-app",\n  "private": true,\n  "scripts": { "dev": "vite", "test": "vitest" }\n}\n',
        "src/App.tsx": 'import { TodoList } from "./components/TodoList";\n\nexport default function App() {\n  return <TodoList />;\n}\n',
        "src/styles.css": CSS,
        "public/favicon.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#3478f6"/><path d="M18 33l9 9 19-20" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>\n',
    })
    png(os.path.join(MAIN, "public/logo.png"), logo((120, 128, 150), False))
    git(MAIN, "add", "-A")
    git(MAIN, "commit", "-q", "-m", t("앱 아이콘 초안", "Draft app icon"), when=NOW - 6 * DAY + HOUR)
    commit(MAIN, t("할 일 추가·완료 표시", "Add todos and mark them done"), 5 * DAY + 3 * HOUR, {
        "src/components/TodoList.tsx": 'import { useState } from "react";\nimport { TodoItem } from "./TodoItem";\n\nexport function TodoList() {\n  const [todos, setTodos] = useState([]);\n  return <ul>{todos.map((t) => <TodoItem key={t.id} todo={t} />)}</ul>;\n}\n',
        "src/components/TodoItem.tsx": 'export function TodoItem({ todo }) {\n  return <li className={todo.done ? "todo done" : "todo"}>{todo.title}</li>;\n}\n',
    })
    commit(MAIN, t("브라우저에 할 일 저장", "Save todos in the browser"), 4 * DAY + 5 * HOUR, {
        "src/lib/storage.ts": 'const KEY = "todos";\nexport const load = () => JSON.parse(localStorage.getItem(KEY) ?? "[]");\nexport const save = (v: unknown) => localStorage.setItem(KEY, JSON.stringify(v));\n',
    }, who=JUN)
    commit(MAIN, t("마감일 순 정렬", "Sort by due date"), 4 * DAY, {"src/lib/sort.ts": SORT_V1})
    git(MAIN, "tag", "v0.1.0")
    # 태그 기능: 브랜치에서 만들고 병합
    git(MAIN, "switch", "-q", "-c", "feature/tags")
    commit(MAIN, t("태그 입력 칸", "Tag input"), 3 * DAY + 6 * HOUR, {"src/components/TagInput.tsx": "export function TagInput() {\n  return <input placeholder=\"" + t("#태그", "#tag") + "\" />;\n}\n"}, who=JUN)
    commit(MAIN, t("태그로 할 일 거르기", "Filter todos by tag"), 3 * DAY + 4 * HOUR, {"src/lib/sort.ts": SORT_V2.replace(SORT_V2_DOC, "").replace("Number(a.done) - Number(b.done) || ", "")}, who=JUN)
    git(MAIN, "switch", "-q", "main")
    commit(MAIN, t("할 일 개수 표시", "Show todo count"), 3 * DAY + 2 * HOUR, {"src/components/Count.tsx": "export const Count = ({ n }: { n: number }) => <small>{n}" + t("개 남음", " left") + "</small>;\n"})
    git(MAIN, "merge", "-q", "--no-ff", "feature/tags", "-m", t("태그 기능 병합 (feature/tags)", "Merge tags feature (feature/tags)"), when=NOW - 3 * DAY, who=JUN)
    commit(MAIN, t("정렬이 끝난 일을 섞던 문제 고침", "Fix sort mixing in finished todos"), 1 * DAY + 2 * HOUR, ai=CLAUDE, files={"src/lib/sort.ts": SORT_V2, "tests/sort.test.ts": 'import { sortTodos } from "../src/lib/sort";\n\ntest("' + t("안 끝난 일이 먼저", "open todos come first") + '", () => {\n  expect(sortTodos([{ id: "1", title: "a", done: true, tags: [] }, { id: "2", title: "b", done: false, tags: [] }])[0].id).toBe("2");\n});\n'})
    git(MAIN, "remote", "add", "origin", os.path.join(ROOT, "remote", "todo-app.git"))
    git(MAIN, "push", "-q", "origin", "main", "feature/tags", "v0.1.0")
    git(MAIN, "branch", "-q", "--set-upstream-to=origin/main", "main")
    commit(MAIN, t("README 에 실행 방법 추가", "Add run steps to README"), 3 * HOUR, {"README.md": readme + "\n```bash\npnpm install\npnpm dev\n```\n"})
    # 워크트리가 없는 갈래(흐리게 보임)
    git(MAIN, "branch", "-q", "feature/export", "HEAD~2")
    git(MAIN, "switch", "-q", "feature/export")
    commit(MAIN, t("CSV 내보내기 초안", "Draft CSV export"), 2 * DAY, {"src/lib/export.ts": "export const toCsv = (rows: string[][]) => rows.map((r) => r.join(\",\")).join(\"\\n\");\n"}, who=JUN)
    git(MAIN, "switch", "-q", "main")
    # 에이전트마다 따로 쓰는 워크트리
    git(MAIN, "worktree", "add", "-q", "-b", "agent/login", LOGIN, "HEAD~1")
    commit(LOGIN, t("로그인 화면 뼈대", "Login screen skeleton"), 2 * HOUR + 30 * MIN, {"src/pages/Login.tsx": "export function Login() {\n  return <form>…</form>;\n}\n"}, ai=CLAUDE)
    commit(LOGIN, t("이메일 형식 검사", "Validate email format"), 1 * HOUR + 40 * MIN, {"src/lib/validate.ts": "export const isEmail = (s: string) => /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(s);\n"}, ai=CLAUDE)
    commit(LOGIN, t("로그인 상태 유지", "Keep users signed in"), 25 * MIN, {"src/lib/auth.ts": "export const session = { get: () => localStorage.getItem(\"token\") };\n"}, ai=CLAUDE)
    write(os.path.join(LOGIN, "src/pages/Login.tsx"), "export function Login() {\n  // TODO: " + t("비밀번호 보기 버튼", "show-password button") + "\n  return <form>…</form>;\n}\n")
    git(MAIN, "worktree", "add", "-q", "-b", "agent/dark-mode", DARK, "HEAD")
    commit(DARK, t("색을 CSS 변수로 정리", "Move colors into CSS variables"), 1 * HOUR + 10 * MIN, {"src/styles.css": CSS + "\n.card { background: var(--bg); }\n"}, who=JUN, ai=CODEX)
    commit(DARK, t("다크 모드 켜고 끄기", "Toggle dark mode"), 45 * MIN, {"src/styles.css": CSS + "\n@media (prefers-color-scheme: dark) {\n  :root { --bg: #1c1c1e; --fg: #f5f5f7; }\n}\n.card { background: var(--bg); }\n"}, who=JUN, ai=CODEX)
    # 메인 워크트리에 커밋 안 한 변경(변경 사항 탭·부분 담기 그림용)
    write(os.path.join(MAIN, "src/lib/sort.ts"), SORT_WORKING)
    write(os.path.join(MAIN, "src/styles.css"), CSS.replace("padding: 8px 12px", "padding: 10px 14px"))
    png(os.path.join(MAIN, "public/logo.png"), logo((52, 120, 246), True))
    write(os.path.join(MAIN, "src/lib/date.ts"), "export const isOverdue = (due?: string) => !!due && due < new Date().toISOString().slice(0, 10);\n")


# ───────────────────────── 세션 기록 ─────────────────────────

def iso(ago):
    return datetime.fromtimestamp(NOW - ago, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def claude_session(title, cwd, branch, ago, turns, sid=None):
    """turns: [(user 글, [(종류, 값), …], 답)] — 종류: Read/Write/Edit/Bash"""
    sid = sid or str(uuid.uuid4())
    slug = cwd.replace("/", "-").replace(".", "-").replace("_", "-")
    lines = []
    t = ago + len(turns) * 4 * MIN
    for user, tools, answer in turns:
        lines.append({"type": "user", "cwd": cwd, "gitBranch": branch, "sessionId": sid, "entrypoint": "cli", "timestamp": iso(t), "message": {"role": "user", "content": user}})
        t -= 20
        for kind, val in tools:
            inp = {"command": val, "description": ""} if kind == "Bash" else {"file_path": os.path.join(cwd, val)}
            lines.append({"type": "assistant", "cwd": cwd, "gitBranch": branch, "sessionId": sid, "timestamp": iso(t), "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t" + uuid.uuid4().hex[:8], "name": kind, "input": inp}]}})
            t -= 15
        lines.append({"type": "assistant", "cwd": cwd, "gitBranch": branch, "sessionId": sid, "timestamp": iso(t), "message": {"role": "assistant", "content": [{"type": "text", "text": answer}]}})
        t -= 4 * MIN
    lines.append({"type": "ai-title", "aiTitle": title, "sessionId": sid})
    path = os.path.join(HOME, ".claude", "projects", slug, sid + ".jsonl")
    write(path, "".join(json.dumps(l, ensure_ascii=False) + "\n" for l in lines))
    os.utime(path, (NOW - ago, NOW - ago))
    return sid


CODEX_THREADS = []


def codex_session(title, cwd, branch, ago, turns):
    tid = str(uuid.uuid4())
    t = ago + len(turns) * 5 * MIN
    day = datetime.fromtimestamp(NOW - t)
    lines = [{"timestamp": iso(t), "type": "session_meta", "payload": {"id": tid, "timestamp": iso(t), "cwd": cwd, "source": "cli", "git": {"branch": branch}}}]
    for user, cmds, files, answer in turns:
        lines.append({"timestamp": iso(t), "type": "event_msg", "payload": {"type": "item_completed", "item": {"type": "UserMessage", "content": [{"type": "text", "text": user}]}}})
        t -= 30
        for c in cmds:
            lines.append({"timestamp": iso(t), "type": "event_msg", "payload": {"type": "item_completed", "item": {"type": "CommandExecution", "command": ["bash", "-lc", c], "exit_code": 0}}})
            t -= 20
        if files:
            lines.append({"timestamp": iso(t), "type": "event_msg", "payload": {"type": "item_completed", "item": {"type": "FileChange", "changes": {os.path.join(cwd, f): {"type": "update"} for f in files}}}})
            t -= 20
        lines.append({"timestamp": iso(t), "type": "event_msg", "payload": {"type": "item_completed", "item": {"type": "AgentMessage", "content": [{"type": "Text", "text": answer}]}}})
        t -= 5 * MIN
    path = os.path.join(HOME, ".codex", "sessions", day.strftime("%Y/%m/%d"), f"rollout-{day.strftime('%Y-%m-%dT%H-%M-%S')}-{tid}.jsonl")
    write(path, "".join(json.dumps(l, ensure_ascii=False) + "\n" for l in lines))
    os.utime(path, (NOW - ago, NOW - ago))
    created = NOW - ago - len(turns) * 5 * MIN
    CODEX_THREADS.append((tid, path, cwd, title, branch, int(created), int(NOW - ago), turns[0][0]))
    return tid


def write_codex_db():
    db = sqlite3.connect(os.path.join(HOME, ".codex", "state_5.sqlite"))
    db.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT, git_branch TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER DEFAULT 0, source TEXT, first_user_message TEXT)")
    for t in CODEX_THREADS:
        db.execute("INSERT INTO threads VALUES (?,?,?,?,?,?,?,0,'cli',?)", (t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7]))
    db.commit()
    db.close()


def make_sessions():
    claude_session(t("로그인 화면 붙이기", "Add login screen"), LOGIN, "agent/login", 8 * MIN, [
        (t("로그인 화면을 만들어 줘. 이메일·비밀번호 칸이랑 로그인 버튼, 이메일 형식이 틀리면 칸 아래에 빨간 안내를 보여 줘.",
           "Build a login screen: email and password fields, a sign-in button, and a red hint under the field when the email format is wrong."),
         [("Read", "src/App.tsx"), ("Write", "src/pages/Login.tsx"), ("Write", "src/lib/validate.ts"), ("Edit", "src/App.tsx"), ("Bash", "pnpm test")],
         t("로그인 화면을 만들었어요. 이메일·비밀번호 칸과 로그인 버튼(src/pages/Login.tsx), 이메일 형식 검사(src/lib/validate.ts)를 넣었고, 형식이 틀리면 칸 아래에 빨간 안내가 떠요. 테스트 8개가 모두 통과했어요.",
           "Done. I added the email and password fields and the sign-in button (src/pages/Login.tsx) plus an email format check (src/lib/validate.ts). A red hint shows under the field when the format is wrong. All 8 tests pass.")),
        (t("새로고침해도 로그인이 풀리지 않게 해 줘.", "Keep me signed in after a page refresh."),
         [("Write", "src/lib/auth.ts"), ("Edit", "src/pages/Login.tsx"), ("Bash", "pnpm test")],
         t("로그인하면 받은 토큰을 브라우저에 저장하고, 앱이 켜질 때 먼저 읽어서 로그인 상태를 되살려요. 로그아웃하면 지워요.",
           "After sign-in the token is saved in the browser, and the app reads it on startup to restore the session. Signing out clears it.")),
    ])
    codex_session(t("다크 모드 넣기", "Add dark mode"), DARK, "agent/dark-mode", 40 * MIN, [
        (t("다크 모드를 넣어 줘. 맥 설정을 따라가고, 화면 오른쪽 위에서 직접 켜고 끌 수도 있게.",
           "Add dark mode. Follow the macOS setting, and let me toggle it from the top right too."),
         ["rg -n \"#fff|#1d1d1f\" src", "pnpm test"], ["src/styles.css", "src/App.tsx"],
         t("색을 CSS 변수로 모으고, 맥 설정(prefers-color-scheme)을 따르는 어두운 색을 넣었어요. 오른쪽 위 달 버튼으로 직접 바꿀 수도 있어요.",
           "I gathered the colors into CSS variables and added dark colors that follow the macOS setting (prefers-color-scheme). The moon button at the top right switches it by hand.")),
    ])
    claude_session(t("정렬 버그 고치기", "Fix sorting bug"), MAIN, "main", 1 * DAY + 3 * HOUR, [
        (t("끝낸 일이 목록 중간에 섞여서 나와. 안 끝난 일이 먼저 오게 고쳐 줘.", "Finished todos show up in the middle of the list. Put the open ones first."),
         [("Read", "src/lib/sort.ts"), ("Edit", "src/lib/sort.ts"), ("Write", "tests/sort.test.ts"), ("Bash", "pnpm test -- sort")],
         t("정렬이 마감일만 보고 있어서 끝낸 일이 섞였어요. 이제 안 끝난 일 → 마감일이 가까운 순으로 정렬해요. 이 경우를 확인하는 테스트도 넣었어요.",
           "The sort only looked at the due date, so finished todos got mixed in. Now it sorts open todos first, then by the nearest due date. I added a test for this case.")),
        (t("좋아. 마감일이 없는 일은 맨 뒤로 보내 줘.", "Nice. Move todos without a due date to the end."),
         [("Edit", "src/lib/sort.ts"), ("Bash", "pnpm test -- sort")],
         t("마감일이 없으면 가장 늦은 날짜처럼 다뤄서 맨 뒤로 가요. 테스트 3개 통과.", "Todos without a due date are treated as the latest date, so they go last. 3 tests pass.")),
    ])
    claude_session(t("태그로 할 일 거르기", "Filter todos by tag"), MAIN, "feature/tags", 3 * DAY + 5 * HOUR, [
        (t("할 일에 #태그를 붙이고, 태그를 누르면 그 태그만 보이게 해 줘.", "Let me add #tags to todos, and show only that tag when I click one."),
         [("Write", "src/components/TagInput.tsx"), ("Edit", "src/lib/sort.ts"), ("Edit", "src/components/TodoList.tsx")],
         t("할 일마다 태그를 붙일 수 있고, 태그를 누르면 그 태그가 붙은 일만 보여요.", "Each todo can have tags now, and clicking a tag shows only the todos that have it.")),
    ])
    codex_session(t("README 정리", "Tidy up README"), MAIN, "main", 2 * DAY + 4 * HOUR, [
        (t("README 를 처음 보는 사람도 바로 실행할 수 있게 정리해 줘.", "Clean up the README so a newcomer can run the app right away."), ["cat package.json"], ["README.md"],
         t("README 에 설치·실행 방법과 폴더 구조를 적었어요.", "I added install and run steps and the folder layout to the README.")),
    ])
    claude_session(t("CSV 내보내기 초안", "Draft CSV export"), MAIN, "feature/export", 5 * DAY, [
        (t("할 일 목록을 CSV 파일로 내보내는 기능 초안만 만들어 줘.", "Just draft a feature that exports the todo list as a CSV file."), [("Write", "src/lib/export.ts")],
         t("toCsv 함수 초안을 만들었어요. 버튼은 아직 붙이지 않았어요.", "I drafted a toCsv function. The button isn't wired up yet.")),
    ])


if __name__ == "__main__":
    make_repo()
    make_sessions()
    write_codex_db()
    print(ROOT)
