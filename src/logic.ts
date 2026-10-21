// 화면과 무관한 순수 로직. 단위 테스트 대상(logic.test.ts).
import type { ChangeKind, ChatInfo, ExecInfo, LinkedSession, LiveRun, StatusEntry } from "./api";

/** Claude 가 detached/저장소 아님일 때 쓰는 "HEAD" 를 사람이 읽을 이름으로 */
export function branchLabel(b: string | null | undefined): string {
  if (!b) return "—";
  if (b === "HEAD") return "브랜치 없음";
  return b;
}

export interface BranchState {
  /** 세션 시작 때 기록된 브랜치 */
  start: string | null;
  /** 마지막 기록의 브랜치 */
  last: string | null;
  /** 워크트리의 지금 브랜치 (Git 실시간) */
  current: string | null;
  currentDetached: boolean;
  /** 시작 기록과 지금이 다름 */
  changedSinceStart: boolean;
  /** 마지막 기록과 지금이 다름 (세션이 끝난 뒤 바뀜) */
  changedSinceLast: boolean;
  /** 워크트리를 실시간으로 읽을 수 없음 (폴더 삭제 등) */
  unknownCurrent: boolean;
}

export function branchState(
  s: Pick<LinkedSession, "startBranch" | "lastBranch" | "currentBranch" | "currentDetached" | "worktreePath" | "cwdExists"> & { cwdMoved?: boolean },
): BranchState {
  const unknownCurrent = !s.worktreePath || !s.cwdExists;
  const current = s.currentDetached ? "HEAD" : s.currentBranch;
  const differs = (rec: string | null) => !unknownCurrent && !!rec && rec !== current;
  return {
    start: s.startBranch,
    last: s.lastBranch,
    current: s.currentBranch,
    currentDetached: s.currentDetached,
    // 대화 도중 다른 워크트리로 옮겼으면 시작 브랜치는 다른 워크트리의 값이라 비교하지 않는다.
    changedSinceStart: !s.cwdMoved && differs(s.startBranch),
    changedSinceLast: differs(s.lastBranch),
    unknownCurrent,
  };
}

/** 앱에서 띄웠지만 아직 기록 파일이 안 생긴 실행을 목록용 가짜 세션으로 만든다. */
export function pendingSessionFromExec(e: ExecInfo): LinkedSession {
  return {
    id: e.sessionId ?? `exec:${e.id}`,
    agent: e.agent,
    externalId: e.sessionId?.split(":")[1] ?? "",
    title: e.agent === "claude" ? "새 Claude 세션" : "새 Codex 세션",
    firstPrompt: null,
    cwd: e.cwd,
    lastCwd: null,
    startBranch: e.branchAtStart,
    lastBranch: e.branchAtStart,
    createdAt: e.startedAt,
    updatedAt: e.startedAt,
    sourcePath: "",
    archived: false,
    origin: "app",
    repoId: null,
    repoName: null,
    worktreePath: e.worktreePath,
    worktreeAlias: null,
    cwdMoved: false,
    cwdExists: true,
    currentBranch: e.branchAtStart,
    currentHead: e.headAtStart,
    currentDetached: false,
    runningExecId: e.exited ? null : e.id,
  };
}

/** 세션 목록 + 아직 목록에 없는 앱 실행·채팅을 합친다. 실행 중인 세션에는 실행 id 를 붙인다. */
export function mergeSessions(sessions: LinkedSession[], execs: ExecInfo[], chats: ChatInfo[] = []): LinkedSession[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const out = sessions.map((s) => {
    const running = execs.find((e) => e.sessionId === s.id && !e.exited);
    return running ? { ...s, runningExecId: running.id } : { ...s, runningExecId: null };
  });
  for (const e of execs) {
    if (e.exited) continue;
    if (e.sessionId && byId.has(e.sessionId)) continue;
    out.unshift(pendingSessionFromExec(e));
  }
  for (const c of chats) {
    if (c.sessionId && (byId.has(c.sessionId) || out.some((x) => x.id === c.sessionId))) continue;
    out.unshift(pendingSessionFromChat(c));
  }
  return out;
}

/** 채팅으로 새로 시작했지만 아직 기록이 없는 대화 */
export function pendingSessionFromChat(c: ChatInfo): LinkedSession {
  return {
    ...pendingSessionFromExec({
      id: c.id,
      sessionId: c.sessionId,
      agent: c.agent,
      kind: "new",
      cwd: c.cwd,
      worktreePath: null,
      branchAtStart: null,
      headAtStart: null,
      startedAt: Date.now(),
      pid: c.pid,
      exited: false,
      exitCode: null,
    }),
    id: c.sessionId ?? `chat:${c.id}`,
    title: c.agent === "claude" ? "새 Claude 채팅" : "새 Codex 채팅",
    worktreePath: c.cwd,
    runningExecId: null,
  };
}

/** 이 세션을 앱 밖(외부 터미널·다른 앱)에서 실행 중인 프로세스 */
export function externalRunOf(sessionId: string, runs: LiveRun[]): LiveRun | null {
  return runs.find((r) => r.sessionId === sessionId && !r.ownedByApp) ?? null;
}

export function clientLabel(client: string): string {
  switch (client) {
    case "cli":
      return "터미널";
    case "sdk":
      return "SDK/다른 앱";
    case "desktop":
      return "Codex Desktop";
    case "app-server":
      return "Codex 앱 서버";
    case "vscode":
      return "VS Code";
    default:
      return client;
  }
}

/** 세션이 최근에 기록되었는지(외부 터미널에서 진행 중일 가능성) */
export function activity(updatedAt: number, now: number): "live" | "recent" | "idle" {
  const age = now - updatedAt;
  if (age < 2 * 60_000) return "live";
  if (age < 60 * 60_000) return "recent";
  return "idle";
}

export function relativeTime(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "방금";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}일 전`;
  const date = new Date(ms);
  return `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}`;
}

/** 절대 경로를 워크트리 기준 상대 경로로. 여러 루트(실제 경로, 심볼릭 링크 경로) 중 맞는 것을 쓴다. 밖이면 null */
export function relativeTo(root: string | (string | null | undefined)[], abs: string): string | null {
  for (const r0 of Array.isArray(root) ? root : [root]) {
    if (!r0) continue;
    const r = r0.endsWith("/") ? r0 : r0 + "/";
    if (abs === r0) return "";
    if (abs.startsWith(r)) return abs.slice(r.length);
  }
  return null;
}

/** git status 가 "dir/" 로 보여 주는 중첩 저장소/워크트리 (커밋하면 gitlink 가 됨) */
export const isNestedRepoEntry = (path: string) => path.endsWith("/");

export function baseName(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/** 경로 → 변경 종류. 폴더는 하위에 변경이 있으면 "modified" 로 표시한다. */
export function decorationMap(entries: StatusEntry[]): { files: Map<string, ChangeKind>; dirs: Map<string, number> } {
  const files = new Map<string, ChangeKind>();
  const dirs = new Map<string, number>();
  for (const e of entries) {
    if (e.kind === "ignored") continue;
    files.set(e.path, e.kind);
    const parts = e.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      dirs.set(d, (dirs.get(d) ?? 0) + 1);
    }
  }
  return { files, dirs };
}

export function kindLetter(k: ChangeKind | undefined): string {
  switch (k) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
    case "conflicted":
      return "!";
    default:
      return "";
  }
}

export function kindLabel(k: ChangeKind | string | undefined): string {
  switch (k) {
    case "modified":
    case "edit":
    case "update":
      return "수정";
    case "added":
    case "add":
    case "write":
      return "추가";
    case "deleted":
    case "delete":
      return "삭제";
    case "renamed":
      return "이름 변경";
    case "untracked":
      return "새 파일";
    case "conflicted":
      return "충돌";
    default:
      return String(k ?? "");
  }
}

/** 위험한 Git 작업 전에 보여 줄 경고 문구. 경고가 없으면 null */
export function checkoutWarning(dirtyCount: number, target: string, otherSessionsHere: number): string | null {
  const parts: string[] = [];
  if (dirtyCount > 0) parts.push(`이 폴더에 커밋하지 않은 변경 ${dirtyCount}개가 있어요. 충돌하지 않는 변경은 '${target}' 으로 함께 옮겨집니다.`);
  if (otherSessionsHere > 0) parts.push(`이 폴더에서 일하는 에이전트가 ${otherSessionsHere}개 있어요. 브랜치를 바꾸면 에이전트가 갑자기 다른 파일을 보게 됩니다.`);
  return parts.length ? parts.join("\n") : null;
}

export const LANE_COLORS = ["#4cc2ff", "#ff7ab2", "#ffb454", "#7ee787", "#c792ea", "#f78c6c", "#56d4bc", "#e5c07b", "#82aaff", "#ff6b6b"];
export const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length];
