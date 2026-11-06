import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeStatus } from "./api";
/** 부를 때마다 하나씩 쌓이고, 시험이 원하는 때에 끝낸다 */
const mock = vi.hoisted(() => ({ calls: [] as { path: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] }));
vi.mock("./api", () => ({
  api: {
    kvSet: async () => {},
    kvGet: async () => null,
    status: (path: string) => new Promise((resolve, reject) => mock.calls.push({ path, resolve, reject })),
  },
  errorText: String,
}));
vi.mock("./panels/TerminalView", () => ({ exposeTerminals: () => {} }));
import { REUSE_MS, worktreeStatus } from "./gitStatus";
import { useStore } from "./store";

const result = (n: number) => ({ branch: `b${n}`, entries: [] }) as unknown as WorktreeStatus;
const flush = () => new Promise((r) => setTimeout(r, 0));
let path = 0;
/** 시험마다 다른 워크트리(공유 표가 모듈에 남아 있어서) */
const fresh = () => `/w/t${++path}`;

beforeEach(() => {
  mock.calls = [];
  useStore.setState({ statusTick: 0, fsSignals: {}, gitSignals: {} });
});
afterEach(() => vi.useRealTimers());

describe("git status 같이 쓰기", () => {
  it("같은 세대에 세 화면이 부르면 git 은 한 번, 결과는 같은 것", async () => {
    const p = fresh();
    const a = worktreeStatus(p), b = worktreeStatus(p), c = worktreeStatus(p);
    expect(mock.calls).toHaveLength(1);
    mock.calls[0].resolve(result(1));
    expect(await a).toBe(await b);
    expect(await c).toEqual(result(1));
    // 막 끝난 것도 같이 쓴다(그래프를 읽고 나서 부르는 Git 패널)
    expect(await worktreeStatus(p)).toEqual(result(1));
    expect(mock.calls).toHaveLength(1);
  });

  it("statusTick 이 오르면 앞선 것이 돌고 있어도 새로 부르고, 새것을 받는다", async () => {
    const p = fresh();
    const before = worktreeStatus(p);
    useStore.setState({ statusTick: 1 });
    const after = worktreeStatus(p);
    expect(mock.calls).toHaveLength(2);
    mock.calls[1].resolve(result(2));
    mock.calls[0].resolve(result(1));
    expect(await before).toEqual(result(1));
    expect(await after).toEqual(result(2));
    // 새 세대에서는 새것을 같이 쓴다
    expect(await worktreeStatus(p)).toEqual(result(2));
    expect(mock.calls).toHaveLength(2);
  });

  it("그 워크트리의 파일·git 신호도 세대를 바꾼다(다른 워크트리 신호는 상관없음)", async () => {
    const p = fresh(), q = fresh();
    void worktreeStatus(p);
    useStore.setState({ fsSignals: { [q]: { n: 1, paths: [] } } });
    void worktreeStatus(p);
    expect(mock.calls).toHaveLength(1);
    useStore.setState({ fsSignals: { [q]: { n: 1, paths: [] }, [p]: { n: 1, paths: ["a"] } } });
    void worktreeStatus(p);
    expect(mock.calls).toHaveLength(2);
    useStore.setState({ gitSignals: { [p]: 1 } });
    void worktreeStatus(p);
    expect(mock.calls).toHaveLength(3);
  });

  it("끝난 결과는 1초 안에서만 다시 쓴다(신호 없이 바뀌는 경우)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const p = fresh();
    const a = worktreeStatus(p);
    mock.calls[0].resolve(result(1));
    await a;
    vi.setSystemTime(1_000_000 + REUSE_MS - 1);
    void worktreeStatus(p);
    expect(mock.calls).toHaveLength(1);
    vi.setSystemTime(1_000_000 + REUSE_MS);
    void worktreeStatus(p);
    expect(mock.calls).toHaveLength(2);
  });

  it("돌고 있는 것은 오래 걸려도 같은 세대면 같이 쓴다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(2_000_000);
    const p = fresh();
    void worktreeStatus(p);
    vi.setSystemTime(2_000_000 + 10 * REUSE_MS);
    void worktreeStatus(p);
    expect(mock.calls).toHaveLength(1);
  });

  it("실패는 같이 쓰지 않는다: 같은 때 기다리던 화면은 같은 실패를 받고, 다음 부름은 새로", async () => {
    const p = fresh();
    const a = worktreeStatus(p), b = worktreeStatus(p);
    mock.calls[0].reject(new Error("git 실패"));
    await expect(a).rejects.toThrow("git 실패");
    await expect(b).rejects.toThrow("git 실패");
    await flush();
    void worktreeStatus(p);
    expect(mock.calls).toHaveLength(2);
  });

  it("워크트리마다 따로", () => {
    const p = fresh(), q = fresh();
    void worktreeStatus(p);
    void worktreeStatus(q);
    void worktreeStatus(p);
    expect(mock.calls.map((x) => x.path)).toEqual([p, q]);
  });
});
