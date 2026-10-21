import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoSummary } from "./api";
const mock = vi.hoisted(() => ({ values: new Map<string, string>(), repos: [] as RepoSummary[] }));
vi.mock("./api", () => ({
  api: {
    kvSet: vi.fn(async (k: string, v: string) => { mock.values.set(k, v); }),
    kvGet: vi.fn(async (k: string) => mock.values.get(k) ?? null),
    appInfo: async () => null, setLang: async () => {}, repoList: async () => mock.repos,
    execList: async () => [], chatList: async () => [], sessions: async () => [], liveRuns: async () => [],
  }, errorText: String,
}));
vi.mock("./panels/TerminalView", () => ({ exposeTerminals: () => {} }));
import { useStore } from "./store";
import { pendingSessionFromExec } from "./logic";
const repo = (id: string): RepoSummary => ({ id, name: id, path: `/${id}`, pinned: true, addedAt: 0, exists: true, error: null, worktrees: [{path:`/${id}`,exists:true,isMain:true,bare:false,head:null,branch:"main",detached:false,locked:null,prunable:null}] });
const original = useStore.getState();
beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null });
  mock.values.clear(); mock.repos = [repo("a"),repo("b"),repo("c")];
  useStore.setState({ ...original, repos: mock.repos, openRepoIds: [], repoTabPaths: {}, info:null });
});
describe("repository tabs", () => {
  const session = (repo: string, id: string, running = true) => pendingSessionFromExec({id,sessionId:null,agent:"codex",kind:"new",cwd:`/${repo}`,worktreePath:`/${repo}`,branchAtStart:"main",headAtStart:null,startedAt:1,pid:123,exited:!running,exitCode:null});
  it("returning to a repository restores its selected agent session", () => {
    const a = session("a","one"), b = session("b","two");
    useStore.setState({sessions:[a,b]});
    useStore.getState().openRepoTab("a");
    useStore.getState().selectSession(a.id);
    useStore.getState().openRepoTab("b");
    expect(useStore.getState().selectedSessionId).toBe(b.id);
    useStore.getState().openRepoTab("a");
    expect(useStore.getState().selectedSessionId).toBe(a.id);
    expect(JSON.parse(mock.values.get("repoTabs")!).sessions.a).toBe(a.id);
  });
  it("a remembered selected session wins over another running session", () => {
    const a = session("a","previous",false), other = session("a","running");
    useStore.setState({sessions:[a,other]});
    useStore.getState().openRepoTab("a"); useStore.getState().selectSession(a.id);
    useStore.getState().openRepoTab("b"); useStore.getState().openRepoTab("a");
    expect(useStore.getState().selectedSessionId).toBe(a.id);
  });
  it("missing remembered session falls back to a running session in the worktree", () => {
    const a = session("a","active");
    useStore.setState({sessions:[a],repoTabSessions:{a:"removed"}});
    useStore.getState().openRepoTab("a"); expect(useStore.getState().selectedSessionId).toBe(a.id);
  });

  it("opening and reopening deduplicates while remembering the worktree", () => {
    useStore.getState().setFocusWorktree("/a"); useStore.getState().openRepoTab("b"); useStore.getState().openRepoTab("a");
    expect(useStore.getState().openRepoIds).toEqual(["a","b"]);
    expect(useStore.getState().focus?.worktreePath).toBe("/a");
    expect(JSON.parse(mock.values.get("repoTabs")!).paths.a).toBe("/a");
  });
  it("closing active selects neighbor; closing last clears selection without ending jobs", () => {
    for (const id of ["a","b","c"]) useStore.getState().openRepoTab(id);
    useStore.getState().openRepoTab("b");
    const execs = useStore.getState().execs;
    useStore.getState().closeRepoTab("b"); expect(useStore.getState().focus?.worktreePath).toBe("/c");
    useStore.getState().closeRepoTab("a"); expect(useStore.getState().focus?.worktreePath).toBe("/c");
    useStore.getState().closeRepoTab("c");
    expect(useStore.getState().focus).toBeNull(); expect(useStore.getState().selectedSessionId).toBeNull();
    expect(useStore.getState().execs).toBe(execs); expect(JSON.parse(mock.values.get("repoTabs")!).ids).toEqual([]);
  });
  it("background repo discovery does not reopen tabs", async () => {
    useStore.getState().openRepoTab("a"); useStore.getState().closeRepoTab("a");
    await useStore.getState().refreshRepos(); expect(useStore.getState().openRepoIds).toEqual([]);
  });
  it("boot keeps explicit empty tabs even with a legacy focus", async () => {
    mock.values.set("focus", JSON.stringify({worktreePath:"/a",source:"manual"}));
    mock.values.set("repoTabs", JSON.stringify({ids:[],paths:{a:"/a"}}));
    await useStore.getState().boot(); expect(useStore.getState().openRepoIds).toEqual([]); expect(useStore.getState().focus).toBeNull();
  });
  it("boot migrates only the previous focus, not all discovered repos", async () => {
    mock.values.set("focus", JSON.stringify({worktreePath:"/b",source:"manual"}));
    await useStore.getState().boot(); expect(useStore.getState().openRepoIds).toEqual(["b"]);
  });
});
