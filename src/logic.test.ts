import { describe, expect, it } from "vitest";
import type { ExecInfo, LinkedSession } from "./api";
import { activity, branchState, checkoutWarning, decorationMap, mergeSessions, relativeTo } from "./logic";

const base: LinkedSession = {
  id: "claude:a",
  agent: "claude",
  externalId: "a",
  title: "t",
  firstPrompt: null,
  cwd: "/r",
  startBranch: "feat",
  lastBranch: "feat",
  createdAt: 0,
  updatedAt: 0,
  sourcePath: "",
  archived: false,
  origin: "cli",
  repoId: "/r/.git",
  repoName: "r",
  worktreePath: "/r",
  cwdExists: true,
  currentBranch: "feat",
  currentHead: "abc",
  currentDetached: false,
  runningExecId: null,
};

const exec = (over: Partial<ExecInfo>): ExecInfo => ({
  id: "e1",
  sessionId: null,
  agent: "codex",
  kind: "new",
  cwd: "/r",
  worktreePath: "/r",
  branchAtStart: "main",
  headAtStart: "abc",
  startedAt: 5,
  pid: 1,
  exited: false,
  exitCode: null,
  ...over,
});

describe("branchState", () => {
  it("does not flag when branch unchanged", () => {
    const s = branchState(base);
    expect(s.changedSinceStart).toBe(false);
    expect(s.changedSinceLast).toBe(false);
  });
  it("flags branch moved after session started", () => {
    const s = branchState({ ...base, currentBranch: "main" });
    expect(s.changedSinceStart).toBe(true);
    expect(s.current).toBe("main");
    expect(s.start).toBe("feat");
  });
  it("treats detached as HEAD and missing worktree as unknown", () => {
    expect(branchState({ ...base, currentBranch: null, currentDetached: true }).changedSinceStart).toBe(true);
    const gone = branchState({ ...base, cwdExists: false, currentBranch: null });
    expect(gone.unknownCurrent).toBe(true);
    expect(gone.changedSinceStart).toBe(false);
  });
});

describe("mergeSessions", () => {
  it("attaches running exec and adds pending execs on top", () => {
    const merged = mergeSessions([base], [exec({ id: "r1", sessionId: "claude:a", agent: "claude" }), exec({ id: "p1" })]);
    expect(merged[0].id).toBe("exec:p1");
    expect(merged[1].runningExecId).toBe("r1");
  });
  it("ignores exited execs", () => {
    const merged = mergeSessions([base], [exec({ id: "x", exited: true })]);
    expect(merged).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("relativeTo stays inside root", () => {
    expect(relativeTo("/r", "/r/src/a.ts")).toBe("src/a.ts");
    expect(relativeTo("/r", "/r2/a.ts")).toBeNull();
  });
  it("decorationMap marks parent dirs", () => {
    const d = decorationMap([
      { path: "src/a/b.ts", origPath: null, index: ".", worktree: "M", kind: "modified" },
      { path: "x.txt", origPath: null, index: "?", worktree: "?", kind: "untracked" },
    ]);
    expect(d.dirs.get("src")).toBe(1);
    expect(d.dirs.get("src/a")).toBe(1);
    expect(d.files.get("x.txt")).toBe("untracked");
  });
  it("activity buckets", () => {
    expect(activity(1000, 1000 + 30_000)).toBe("live");
    expect(activity(0, 10 * 60_000)).toBe("recent");
    expect(activity(0, 2 * 3600_000)).toBe("idle");
  });
  it("checkout warning mentions dirty files and sessions", () => {
    expect(checkoutWarning(0, "main", 0)).toBeNull();
    const w = checkoutWarning(2, "main", 1)!;
    expect(w).toContain("2개");
    expect(w).toContain("에이전트");
  });
});
