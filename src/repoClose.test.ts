import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecInfo, LiveRun, RepoSummary } from "./api";
const mock = vi.hoisted(() => ({ killed: [] as string[], fail: new Set<string>() }));
vi.mock("./api", () => ({
  api: {
    kvSet: async () => {},
    kvGet: async () => null,
    execKill: vi.fn(async (id: string) => {
      if (mock.fail.has(id)) throw new Error(`kill ${id} failed`);
      mock.killed.push(id);
    }),
  },
  errorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("./panels/TerminalView", () => ({ exposeTerminals: () => {} }));
import { pendingSessionFromExec } from "./logic";
import { closePrompt, closeRepoTabAsking } from "./repoClose";
import { useStore } from "./store";

const repo = (id: string): RepoSummary => ({ id, name: id, path: `/w/${id}`, pinned: true, addedAt: 0, exists: true, error: null, worktrees: [{ path: `/w/${id}`, exists: true, isMain: true, bare: false, head: null, branch: "main", detached: false, locked: null, prunable: null }] });
const exec = (id: string, repo: string, pid: number): ExecInfo => ({ id, sessionId: null, agent: "claude", kind: "new", cwd: `/w/${repo}`, worktreePath: `/w/${repo}`, branchAtStart: "main", headAtStart: null, startedAt: 1, pid, exited: false, exitCode: null });
const run = (o: Partial<LiveRun>): LiveRun => ({ sessionId: "claude:x", agent: "claude", pid: 1, client: "cli", status: null, cwd: null, startedAt: 0, ownedByApp: false, ...o });
const original = useStore.getState();
const counts = { waiting: 0, busy: 0, unknown: 0, idle: 0 };

/** 앱 터미널: a 에 둘(확인 필요·일하는 중), b 에 없음. 앱 밖: a 하위 폴더 하나, b 하나 */
function setup() {
  const execs = [exec("e1", "a", 41), exec("e2", "a", 42)];
  useStore.setState({
    ...original,
    repos: [repo("a"), repo("b")],
    openRepoIds: ["a", "b"],
    focus: null,
    toasts: [],
    confirm: null,
    execs,
    sessions: execs.map(pendingSessionFromExec),
    liveRuns: [
      run({ pid: 41, status: "waiting", ownedByApp: true, cwd: "/w/a" }),
      run({ pid: 42, status: "busy", ownedByApp: true, cwd: "/w/a" }),
      run({ sessionId: "claude:out-a", pid: 50, status: "busy", cwd: "/w/a/src" }),
      run({ sessionId: "claude:out-b", pid: 51, status: "idle", cwd: "/w/b" }),
    ],
  });
}

/** 닫기를 시작하고 확인창이 뜨면 answer 로 답한다. 확인창이 안 떴으면 asked=false */
async function closeWith(id: string, answer: boolean | "alt") {
  const done = closeRepoTabAsking(id);
  await Promise.resolve();
  const req = useStore.getState().confirm;
  req?.resolve(answer);
  return { closed: await done, asked: !!req, req };
}

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null });
  mock.killed = [];
  mock.fail.clear();
  setup();
});

describe("저장소 탭 닫기: 실행 중인 AI 를 멈출지", () => {
  it("앱 터미널 AI 가 있으면 세 단추로 묻고, 취소하면 탭도 AI 도 그대로", async () => {
    const { closed, asked, req } = await closeWith("a", false);
    expect(asked).toBe(true);
    expect(req?.title).toBe("a 에서 AI 가 실행 중이에요");
    expect(req?.confirmLabel).toBe("그대로 두고 닫기");
    expect(req?.altLabel).toBe("멈추고 닫기");
    expect(req?.danger).toBeFalsy(); // 기본 포커스는 멈추지 않는 쪽
    expect(closed).toBe(false);
    expect(useStore.getState().openRepoIds).toEqual(["a", "b"]);
    expect(mock.killed).toEqual([]);
  });

  it("그대로 두고 닫기 → 탭만 닫히고 아무것도 끝내지 않는다", async () => {
    const { closed } = await closeWith("a", true);
    expect(closed).toBe(true);
    expect(useStore.getState().openRepoIds).toEqual(["b"]);
    expect(mock.killed).toEqual([]);
  });

  it("멈추고 닫기 → 그 저장소의 앱 실행만 끝내고 닫는다(앱 밖 실행·다른 저장소는 건드리지 않음)", async () => {
    const { closed } = await closeWith("a", "alt");
    expect(closed).toBe(true);
    expect(mock.killed.sort()).toEqual(["e1", "e2"]);
    expect(useStore.getState().openRepoIds).toEqual(["b"]);
  });

  it("묻는 사이 스스로 끝난 실행은 건너뛴다", async () => {
    const done = closeRepoTabAsking("a");
    await Promise.resolve();
    useStore.setState({ execs: useStore.getState().execs.map((e) => (e.id === "e1" ? { ...e, exited: true } : e)) });
    useStore.getState().confirm?.resolve("alt");
    expect(await done).toBe(true);
    expect(mock.killed).toEqual(["e2"]);
  });

  it("멈추지 못하면 탭을 닫지 않고 알린다", async () => {
    mock.fail.add("e2");
    const { closed } = await closeWith("a", "alt");
    expect(closed).toBe(false);
    expect(useStore.getState().openRepoIds).toEqual(["a", "b"]);
    expect(useStore.getState().toasts.map((x) => [x.kind, x.text])).toEqual([["error", "AI 를 멈추지 못해 탭을 닫지 않았어요: kill e2 failed"]]);
  });

  it("앱 밖 AI 만 있거나 AI 가 없으면 묻지 않고 바로 닫는다", async () => {
    const b = await closeWith("b", "alt");
    expect(b).toMatchObject({ asked: false, closed: true });
    expect(mock.killed).toEqual([]);
    useStore.setState({ liveRuns: [], execs: [], sessions: [] });
    const a = await closeWith("a", "alt");
    expect(a).toMatchObject({ asked: false, closed: true });
    expect(useStore.getState().openRepoIds).toEqual([]);
    expect(mock.killed).toEqual([]);
  });
});

describe("확인창 글", () => {
  it("앱 실행 개수·상태, 대화 기록이 남는다는 것, 앱 밖 실행이 있으면 그 개수", () => {
    const p = closePrompt("web", { execIds: ["e1", "e2"], app: { ...counts, waiting: 1, busy: 1 }, outside: 1 });
    expect(p?.body.split("\n")).toEqual([
      "앱 터미널에서 띄운 AI 2개가 아직 돌고 있어요 (확인 필요 1 · 일하는 중 1).",
      "멈추면 프로세스를 끝내요. 대화 기록은 남아 있어 나중에 이어갈 수 있어요.",
      "그대로 두면 탭만 닫히고 AI 는 계속 돌아요.",
      "다른 터미널에서 띄운 AI 1개는 멈추지 않아요.",
    ]);
    expect(closePrompt("web", { execIds: ["e1"], app: { ...counts, unknown: 1 }, outside: 0 })?.body).not.toContain("다른 터미널");
    expect(closePrompt("web", { execIds: [], app: counts, outside: 3 })).toBeNull();
  });
});
