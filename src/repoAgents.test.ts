import { describe, expect, it } from "vitest";
import type { LiveRun } from "./api";
import { agentState, agentSummary, agentsByRepo, runsInRepo, stateCounts, topState, type RepoAgents } from "./repoAgents";

const repo = (id: string, path: string, more: string[] = []) => ({ id, path, worktrees: [path, ...more].map((p) => ({ path: p })) }) as never;
const session = (id: string, o: { repo?: string | null; wt?: string | null; cwd?: string | null; exec?: string | null } = {}) => ({
  id,
  repoId: o.repo ?? null,
  worktreePath: o.wt ?? null,
  cwd: o.cwd ?? null,
  runningExecId: o.exec ?? null,
});
const run = (sessionId: string, o: Partial<LiveRun> = {}): LiveRun => ({
  sessionId,
  agent: sessionId.startsWith("codex:") ? "codex" : "claude",
  pid: 1,
  client: "cli",
  status: null,
  cwd: null,
  startedAt: 0,
  ownedByApp: false,
  ...o,
});
const counts = (o: Partial<RepoAgents> = {}): RepoAgents => ({ waiting: 0, busy: 0, unknown: 0, idle: 0, ...o });
const repos = [repo("a", "/w/a", ["/w/a-feature"]), repo("ab", "/w/ab"), repo("p", "/w/p")];

describe("Claude 상태 → 화면 상태", () => {
  it("busy·shell 은 일하는 중, waiting 은 확인 필요, idle 은 대기, 그 밖(Codex 는 없음)은 모름", () => {
    expect(agentState("busy")).toBe("busy");
    expect(agentState("shell")).toBe("busy");
    expect(agentState("waiting")).toBe("waiting");
    expect(agentState("idle")).toBe("idle");
    expect(agentState(null)).toBe("unknown");
    expect(agentState("something-new")).toBe("unknown");
  });
});

describe("저장소별 AI 세기", () => {
  it("앱 터미널 실행은 같은 pid 의 감지 결과로 상태를 얻고, 앱이 띄운 감지는 다시 세지 않는다", () => {
    const sessions = [session("claude:s1", { repo: "a", wt: "/w/a", exec: "e1" })];
    const runs = [run("claude:s1", { pid: 42, status: "busy", ownedByApp: true, cwd: "/w/a" })];
    const m = agentsByRepo(repos, sessions, runs, [{ id: "e1", pid: 42 }]);
    expect(m.get("a")).toEqual(counts({ busy: 1 }));
    expect(m.size).toBe(1);
  });

  it("아직 세션 id 가 없는 새 실행(exec:…)도 pid 로 상태를 찾는다", () => {
    const sessions = [session("exec:e2", { wt: "/w/a", cwd: "/w/a", exec: "e2" })];
    const runs = [run("claude:fresh", { pid: 77, status: "waiting", ownedByApp: true, cwd: "/w/a" })];
    expect(agentsByRepo(repos, sessions, runs, [{ id: "e2", pid: 77 }]).get("a")).toEqual(counts({ waiting: 1 }));
  });

  it("pid 가 다르면(감싸개 스크립트 아래 자식이 실제 에이전트) 같은 세션의 앱 실행 감지로", () => {
    const sessions = [session("claude:c1", { repo: "a", wt: "/w/a", exec: "e3" })];
    const runs = [run("claude:c1", { pid: 900, status: "busy", ownedByApp: true }), run("claude:c1", { pid: 901, status: "idle" })];
    // 앱 밖에서 같은 세션을 돌리는 것(901)의 상태를 앱 실행의 상태로 가져오지 않는다
    expect(agentsByRepo(repos, sessions, runs, [{ id: "e3", pid: 899 }]).get("a")).toEqual(counts({ busy: 1, idle: 1 }));
    expect(agentsByRepo(repos, sessions, runs.slice(0, 1), [{ id: "e3", pid: null }]).get("a")).toEqual(counts({ busy: 1 }));
  });

  it("감지가 아직 안 된 앱 실행도 센다(상태 모름)", () => {
    const sessions = [session("claude:s4", { repo: "a", wt: "/w/a", exec: "e4" })];
    expect(agentsByRepo(repos, sessions, [], [{ id: "e4", pid: 5 }]).get("a")).toEqual(counts({ unknown: 1 }));
  });

  it("끝난 실행(runningExecId 없음)과 끝난 세션은 세지 않는다", () => {
    const sessions = [session("claude:old", { repo: "a", wt: "/w/a" })];
    expect(agentsByRepo(repos, sessions, [], []).size).toBe(0);
  });

  it("앱 밖 실행: 상위 폴더에서 시작했어도 연결된 세션의 저장소로 센다", () => {
    const sessions = [session("claude:parent", { repo: "p", wt: "/w/p", cwd: "/w" })];
    const runs = [run("claude:parent", { status: "busy", cwd: "/w" })];
    const m = agentsByRepo(repos, sessions, runs, []);
    expect(m.get("p")).toEqual(counts({ busy: 1 }));
    expect(m.has("a")).toBe(false);
  });

  it("앱 밖 실행: 세션을 모르면 실행 폴더로, 다른 워크트리·하위 폴더도 그 저장소", () => {
    const runs = [run("claude:x", { status: "idle", cwd: "/w/a-feature/src" }), run("codex:y", { cwd: "/w/a" })];
    expect(agentsByRepo(repos, [], runs, []).get("a")).toEqual(counts({ idle: 1, unknown: 1 }));
  });

  it("경로 앞부분만 같은 다른 저장소(/w/a 와 /w/ab)를 섞지 않는다", () => {
    const m = agentsByRepo(repos, [], [run("claude:z", { status: "busy", cwd: "/w/ab/lib" })], []);
    expect(m.get("ab")).toEqual(counts({ busy: 1 }));
    expect(m.has("a")).toBe(false);
    // 등록되지 않은 /w/abc 는 /w/a 의 것이 아니다
    expect(agentsByRepo(repos, [], [run("claude:q", { status: "busy", cwd: "/w/abc" })], []).size).toBe(0);
  });

  it("저장소 안의 저장소는 더 깊은 쪽으로", () => {
    const nested = [repo("outer", "/n"), repo("inner", "/n/inner")];
    const m = agentsByRepo(nested, [], [run("claude:n", { status: "busy", cwd: "/n/inner/x" })], []);
    expect(m.get("inner")).toEqual(counts({ busy: 1 }));
    expect(m.has("outer")).toBe(false);
  });

  it("어느 저장소에도 속하지 않는 실행은 버린다", () => {
    expect(agentsByRepo(repos, [], [run("claude:far", { status: "busy", cwd: "/elsewhere" })], []).size).toBe(0);
  });

  it("같은 세션을 앱과 앱 밖에서 함께 돌리면 둘로 센다", () => {
    const sessions = [session("claude:both", { repo: "a", wt: "/w/a", exec: "e5" })];
    const runs = [run("claude:both", { pid: 10, status: "idle", ownedByApp: true }), run("claude:both", { pid: 11, status: "busy" })];
    expect(agentsByRepo(repos, sessions, runs, [{ id: "e5", pid: 10 }]).get("a")).toEqual(counts({ idle: 1, busy: 1 }));
  });
});

describe("탭에 보일 상태", () => {
  it("확인 필요 > 일하는 중 > 모름 > 대기", () => {
    expect(topState(counts({ idle: 3, busy: 1, waiting: 1 }))).toBe("waiting");
    expect(topState(counts({ idle: 3, busy: 1, unknown: 1 }))).toBe("busy");
    expect(topState(counts({ idle: 3, unknown: 1 }))).toBe("unknown");
    expect(topState(counts({ idle: 1 }))).toBe("idle");
    expect(topState(counts())).toBeNull();
    expect(topState(undefined)).toBeNull();
  });

  it("설명은 상태별 개수를 급한 것부터, 뜻이 필요한 상태는 한 줄 덧붙인다", () => {
    expect(agentSummary(counts({ busy: 2, idle: 1 }))).toBe("AI 일하는 중 2 · 대기 중 1");
    const s = agentSummary(counts({ waiting: 1, unknown: 1 })).split("\n");
    expect(s[0]).toBe("AI 확인 필요 1 · 실행 중 1");
    expect(s).toHaveLength(3);
  });
});

describe("한 저장소의 실행(탭 닫을 때 멈출지 묻기)", () => {
  it("앱 터미널 실행은 실행 id 와 상태로, 앱 밖 실행은 개수만. 다른 저장소 것은 빼고 앱이 띄운 감지는 다시 세지 않는다", () => {
    const sessions = [
      session("claude:s1", { repo: "a", wt: "/w/a", exec: "e1" }),
      session("claude:s2", { wt: "/w/a-feature", exec: "e2" }),
      session("claude:s3", { repo: "ab", wt: "/w/ab", exec: "e3" }),
      session("claude:done", { repo: "a", wt: "/w/a" }),
    ];
    const runs = [
      run("claude:s1", { pid: 41, status: "waiting", ownedByApp: true, cwd: "/w/a" }),
      run("claude:s2", { pid: 42, status: "busy", ownedByApp: true, cwd: "/w/a-feature" }),
      run("claude:out", { pid: 50, status: "busy", cwd: "/w/a/src" }),
      run("claude:other", { pid: 51, status: "busy", cwd: "/w/ab" }),
    ];
    const execs = [{ id: "e1", pid: 41 }, { id: "e2", pid: 42 }, { id: "e3", pid: 43 }];
    const r = runsInRepo("a", repos, sessions, runs, execs);
    expect(r.execIds).toEqual(["e1", "e2"]);
    expect(r.app).toEqual(counts({ waiting: 1, busy: 1 }));
    expect(r.outside).toBe(1);
    expect(runsInRepo("ab", repos, sessions, runs, execs)).toEqual({ execIds: ["e3"], app: counts({ unknown: 1 }), outside: 1 });
    expect(runsInRepo("p", repos, sessions, runs, execs)).toEqual({ execIds: [], app: counts(), outside: 0 });
  });

  it("상위 폴더에서 연결된 앱 세션·아직 세션 id 가 없는 새 실행도 그 저장소 것", () => {
    const sessions = [session("claude:up", { repo: "a", wt: "/w", cwd: "/w", exec: "e7" }), session("exec:e8", { wt: "/w/a", cwd: "/w/a", exec: "e8" })];
    expect(runsInRepo("a", repos, sessions, [], [{ id: "e7", pid: 70 }, { id: "e8", pid: 80 }]).execIds).toEqual(["e7", "e8"]);
  });

  it("상태별 개수 글은 급한 것부터, 0 은 뺀다", () => {
    expect(stateCounts(counts({ idle: 1, waiting: 2, unknown: 1 }))).toBe("확인 필요 2 · 실행 중 1 · 대기 중 1");
    expect(stateCounts(counts())).toBe("");
  });
});
