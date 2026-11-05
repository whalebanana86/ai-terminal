// 저장소 탭의 "지금 AI 가 쓰이는지" 표시. 새로 읽는 것은 없고, 이미 5초마다 도는 실행 감지(procs.rs → live-runs)와
// 세션 목록·앱 실행 목록만 모아 저장소별로 센다.
import type { ExecInfo, LinkedSession, LiveRun, RepoSummary } from "./api";
import { t } from "./i18n";

/** 실행 하나의 상태. unknown 은 상태를 남기지 않는 에이전트(Codex)라 일하는지 알 수 없는 실행 */
export type AgentState = "waiting" | "busy" | "unknown" | "idle";

/** 탭에 하나만 보일 때의 순서: 사람이 봐야 하는 것 → 일하는 것 → 알 수 없는 것 → 쉬는 것 */
export const STATE_ORDER: readonly AgentState[] = ["waiting", "busy", "unknown", "idle"];

export type RepoAgents = Record<AgentState, number>;

/** Claude 가 `~/.claude/sessions/<pid>.json` 에 적는 status(busy·shell·idle·waiting) → 화면 상태.
 *  shell 은 "할 일은 끝났지만 뒤에서 셸 작업이 도는 중"이라, Claude 자신의 목록처럼 일하는 중으로 본다. */
export function agentState(status: string | null | undefined): AgentState {
  switch (status) {
    case "busy":
    case "shell":
      return "busy";
    case "waiting":
      return "waiting";
    case "idle":
      return "idle";
    default:
      return "unknown";
  }
}

const empty = (): RepoAgents => ({ waiting: 0, busy: 0, unknown: 0, idle: 0 });
const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith("/") ? root : root + "/");

type Repo = Pick<RepoSummary, "id" | "path" | "worktrees">;
type Session = Pick<LinkedSession, "id" | "repoId" | "worktreePath" | "cwd" | "runningExecId">;

/** 저장소마다(모든 워크트리 포함) 지금 도는 에이전트를 상태별로 센다. 에이전트가 없는 저장소는 결과에 없다.
 *  - 앱 터미널 실행: 실행 중인 세션 하나가 하나. 상태는 같은 pid(없으면 같은 세션의 앱 실행)의 감지 결과에서.
 *  - 앱 밖 실행: 연결된 세션의 저장소로(상위 폴더에서 시작해 하위 저장소에서 일한 세션도), 세션을 모르면 실행 폴더로. */
export function agentsByRepo(repos: Repo[], sessions: Session[], runs: LiveRun[], execs: Pick<ExecInfo, "id" | "pid">[]): Map<string, RepoAgents> {
  const roots = repos.flatMap((r) => [r.path, ...r.worktrees.map((w) => w.path)].map((root) => ({ id: r.id, root })));
  // 저장소 안에 다른 저장소가 있으면 더 깊은 쪽
  const repoOf = (path: string | null | undefined) => {
    if (!path) return null;
    let best: { id: string; root: string } | null = null;
    for (const x of roots) if (inside(path, x.root) && (!best || x.root.length > best.root.length)) best = x;
    return best?.id ?? null;
  };
  const known = new Set(repos.map((r) => r.id));
  const sessionRepo = (s: Session | undefined, cwd?: string | null) => (s?.repoId && known.has(s.repoId) ? s.repoId : repoOf(cwd ?? s?.worktreePath ?? s?.cwd));
  const out = new Map<string, RepoAgents>();
  const add = (repo: string | null, state: AgentState) => {
    if (!repo) return;
    const a = out.get(repo) ?? empty();
    a[state]++;
    out.set(repo, a);
  };
  for (const s of sessions) {
    if (!s.runningExecId) continue;
    const pid = execs.find((e) => e.id === s.runningExecId)?.pid;
    const run = (pid != null ? runs.find((r) => r.pid === pid) : undefined) ?? runs.find((r) => r.ownedByApp && r.sessionId === s.id);
    add(sessionRepo(s), agentState(run?.status));
  }
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const r of runs) {
    if (r.ownedByApp) continue; // 앱이 띄운 것은 위에서 세션으로 셌다
    const s = byId.get(r.sessionId);
    add(sessionRepo(s, r.cwd), agentState(r.status));
  }
  return out;
}

/** 탭에 보일 상태 하나 */
export function topState(a: RepoAgents | undefined): AgentState | null {
  return a ? (STATE_ORDER.find((k) => a[k] > 0) ?? null) : null;
}

export function stateLabel(state: AgentState): string {
  switch (state) {
    case "waiting":
      return t("확인 필요");
    case "busy":
      return t("일하는 중");
    case "unknown":
      return t("실행 중");
    case "idle":
      return t("대기 중");
  }
}

/** 마우스를 올렸을 때의 설명: "AI 확인 필요 1 · 일하는 중 2" (+ 일하는지 모르는 실행이 있으면 그 뜻) */
export function agentSummary(a: RepoAgents): string {
  const parts = STATE_ORDER.filter((k) => a[k] > 0).map((k) => `${stateLabel(k)} ${a[k]}`);
  const lines = [`AI ${parts.join(" · ")}`];
  if (a.waiting) lines.push(t("확인 필요: 승인이나 질문의 답을 기다려요"));
  if (a.unknown) lines.push(t("실행 중: 일하는지 알 수 없는 에이전트(Codex 등)"));
  return lines.join("\n");
}
