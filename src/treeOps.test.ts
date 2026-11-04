import { beforeEach, describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ log: [] as string[], fail: null as string | null }));
vi.mock("./api", () => ({
  api: {
    kvSet: async () => {},
    kvGet: async () => null,
    extensionsList: async () => [],
    extensionSet: async () => [],
    fsCreate: async (_w: string, dir: string, name: string, isDir: boolean) => {
      calls.log.push(`create ${dir}|${name}|${isDir}`);
      if (calls.fail) throw new Error(calls.fail);
      return dir ? `${dir}/${name}` : name;
    },
    fsRename: async (_w: string, rel: string, name: string) => {
      calls.log.push(`rename ${rel}|${name}`);
      if (calls.fail) throw new Error(calls.fail);
      const i = rel.lastIndexOf("/");
      return i < 0 ? name : `${rel.slice(0, i)}/${name}`;
    },
    fsTrash: async (_w: string, rel: string) => {
      calls.log.push(`trash ${rel}`);
      if (calls.fail) throw new Error(calls.fail);
    },
  },
  errorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("./panels/TerminalView", () => ({ exposeTerminals: () => {} }));
vi.mock("./panels/FilePanel", () => ({ FileViewer: () => null }));
import { Text } from "@codemirror/state";
import { draftRelsUnder, getDraft, moveDrafts, setDraft } from "./extensions/editor/drafts";
import { useExtensions } from "./extensions";
import { movedRel, stemEnd } from "./logic";
import { fileTabId, pathsMoved, useStore, type FileTab } from "./store";
import { followExpanded, nameProblem, newEntry, renameEntry, spotDir, trashEntry, treeMenu } from "./treeOps";

const W = "/r/wt";
const draft = (s: string) => ({ doc: Text.of([s]), hash: "h", crlf: false, bom: false });
const tab = (rel: string, worktree = W): FileTab => {
  const viewer = { kind: "file" as const, rel, mode: "preview" as const };
  return { id: fileTabId(worktree, viewer), worktree, viewer };
};
const st = () => useStore.getState();
const tick = () => new Promise((r) => setTimeout(r, 0));
/** 열린 입력창·확인창에 답한다 */
async function answerPrompt(values: Record<string, string> | null) {
  await tick();
  const p = st().prompt;
  if (!p) throw new Error("입력창이 안 떴다");
  p.resolve(values);
}
async function answerConfirm(ok: boolean) {
  await tick();
  const c = st().confirm;
  if (!c) throw new Error("확인창이 안 떴다");
  c.resolve(ok);
}

describe("새 이름 검사", () => {
  it("쓸 수 있는 이름", () => {
    for (const ok of ["a.ts", "새 파일.md", ".env", "a:b", "x".repeat(255), "가".repeat(85)]) expect(nameProblem(ok, [])).toBeNull();
  });
  it("빈 이름·.·..·/·제어 문자·.git·255바이트 넘는 이름", () => {
    for (const bad of ["", ".", "..", "a/b", "/", "a\nb", "a\rb", "a\u001bb", "a\u0085b", ".git", ".GIT", "가".repeat(86)]) expect(nameProblem(bad, []), JSON.stringify(bad)).not.toBeNull();
  });
  it("같은 폴더의 이름과 겹치면(대소문자·한글 자모 나눔도 같게) 거부, 이름 바꾸기는 대소문자만 바꾸는 것은 된다", () => {
    const sib = ["a.ts", "한글.md".normalize("NFD"), "docs"];
    expect(nameProblem("A.TS", sib)).toBe("같은 이름이 이미 있어요: A.TS");
    expect(nameProblem("한글.md", sib)).not.toBeNull();
    expect(nameProblem("DOCS", sib)).not.toBeNull();
    expect(nameProblem("b.ts", sib)).toBeNull();
    expect(nameProblem("A.ts", sib, "a.ts")).toBeNull();
    expect(nameProblem("docs", sib, "a.ts")).not.toBeNull();
  });
});

describe("경로 돕기", () => {
  it("이름 바꾼 파일·폴더를 따라간 경로(이름이 앞만 같은 옆 폴더는 아님)", () => {
    expect(movedRel("src/a.ts", "src/a.ts", "src/b.ts")).toBe("src/b.ts");
    expect(movedRel("src/ui/c.ts", "src/ui", "src/view")).toBe("src/view/c.ts");
    expect(movedRel("src/ui2/c.ts", "src/ui", "src/view")).toBeNull();
    expect(movedRel("src", "src/ui", "src/view")).toBeNull();
  });
  it("처음 골라 둘 곳: 확장자 앞까지(폴더·점으로 시작·확장자 없음은 전부)", () => {
    expect(stemEnd("notes.md", false)).toBe(5);
    expect(stemEnd("archive.tar.gz", false)).toBe(11);
    expect(stemEnd(".env", false)).toBe(4);
    expect(stemEnd("Makefile", false)).toBe(8);
    expect(stemEnd("my.pkg", true)).toBe(6);
  });
  it("펼친 폴더도 새 이름으로", () => {
    expect([...followExpanded(new Set(["", "src", "src/ui", "src/ui/deep", "src/ui2"]), "src/ui", "src/view")]).toEqual(["", "src", "src/view", "src/view/deep", "src/ui2"]);
  });
});

describe("오른쪽 클릭 메뉴", () => {
  const got: string[] = [];
  const acts = { newEntry: (d: string, isDir: boolean) => got.push(`new ${d}|${isDir}`), rename: (r: string, isDir: boolean) => got.push(`rename ${r}|${isDir}`), trash: (r: string, isDir: boolean) => got.push(`trash ${r}|${isDir}`) };
  beforeEach(() => void (got.length = 0));
  it("빈 곳: 맨 위에 새 파일·새 폴더만", () => {
    const items = treeMenu({ kind: "root" }, acts);
    expect(items.map((x) => x.testId)).toEqual(["tree-new-file", "tree-new-folder"]);
    items.forEach((x) => x.onClick?.());
    expect(got).toEqual(["new |false", "new |true"]);
  });
  it("폴더 줄: 그 안에 만들기, 폴더째 이름 바꾸기·휴지통", () => {
    const items = treeMenu({ kind: "dir", rel: "src/ui" }, acts);
    expect(items.map((x) => x.testId ?? (x.separator ? "-" : ""))).toEqual(["tree-new-file", "tree-new-folder", "-", "tree-rename", "tree-trash"]);
    expect(items.find((x) => x.testId === "tree-trash")?.danger).toBe(true);
    items.forEach((x) => x.onClick?.());
    expect(got).toEqual(["new src/ui|false", "new src/ui|true", "rename src/ui|true", "trash src/ui|true"]);
  });
  it("파일 줄: 그 파일이 든 폴더에 만들기", () => {
    treeMenu({ kind: "file", rel: "src/a.ts" }, acts).forEach((x) => x.onClick?.());
    expect(got).toEqual(["new src|false", "new src|true", "rename src/a.ts|false", "trash src/a.ts|false"]);
    expect(spotDir({ kind: "file", rel: "a.ts" })).toBe("");
  });
});

describe("열어 둔 보기·탭이 따라가기", () => {
  const base = () => ({ ...st(), focus: { worktreePath: W, source: "manual" as const }, viewer: null, fileTabs: [], activeTab: null, tabMemory: {} });
  it("오른쪽 아래 보기: 이름을 따라가고, 지우면 닫는다. 다른 워크트리·커밋 파일은 그대로", () => {
    const s = { ...base(), viewer: { kind: "file" as const, rel: "src/ui/c.ts", mode: "diff" as const } };
    expect(pathsMoved(s, W, "src/ui", "src/view").viewer).toEqual({ kind: "file", rel: "src/view/c.ts", mode: "diff" });
    expect(pathsMoved(s, W, "src/ui", null).viewer).toBeNull();
    expect(pathsMoved(s, "/r/other", "src/ui", null)).toEqual({});
    expect(pathsMoved(s, W, "src/u", null)).toEqual({});
    expect(pathsMoved({ ...s, viewer: { kind: "commit-file", sha: "abc", rel: "src/ui/c.ts" } }, W, "src/ui", null)).toEqual({});
  });
  it("가운데 탭: 폴더 이름을 바꾸면 안의 탭이 새 경로·새 id 로, 보던 탭·저장소별 기억도", () => {
    const [a, c, d, o] = [tab("a.ts"), tab("src/ui/c.ts"), tab("src/ui2/d.ts"), tab("src/ui/c.ts", "/r/other")];
    const s = { ...base(), fileTabs: [a, c, d, o], activeTab: c.id, tabMemory: { repo1: c.id, repo2: a.id } };
    const p = pathsMoved(s, W, "src/ui", "src/view");
    const moved = tab("src/view/c.ts");
    expect(p.fileTabs).toEqual([a, moved, d, o]);
    expect(p.activeTab).toBe(moved.id);
    expect(p.tabMemory).toEqual({ repo1: moved.id, repo2: a.id });
  });
  it("가운데 탭: 지우면 닫고 옆 탭을 보여 준다", () => {
    const [a, c, d] = [tab("a.ts"), tab("src/ui/c.ts"), tab("src/ui/e.ts")];
    const s = { ...base(), fileTabs: [a, c, d], activeTab: c.id, tabMemory: { repo1: d.id } };
    const p = pathsMoved(s, W, "src/ui", null);
    expect(p.fileTabs).toEqual([a]);
    expect(p.activeTab).toBe(a.id);
    expect(p.tabMemory).toEqual({ repo1: null });
  });
});

describe("저장하지 않은 수정", () => {
  it("폴더 이름을 바꾸면 안의 수정이 새 경로로, 이름이 앞만 같은 옆 폴더는 그대로", () => {
    setDraft(W, "lib/x/a.ts", draft("A"));
    setDraft(W, "lib/x2/b.ts", draft("B"));
    setDraft("/r/other", "lib/x/a.ts", draft("O"));
    expect(draftRelsUnder(W, "lib/x")).toEqual(["lib/x/a.ts"]);
    moveDrafts(W, "lib/x", "lib/y");
    expect(getDraft(W, "lib/x/a.ts")).toBeUndefined();
    expect(getDraft(W, "lib/y/a.ts")?.doc.toString()).toBe("A");
    expect(getDraft(W, "lib/x2/b.ts")?.doc.toString()).toBe("B");
    expect(getDraft("/r/other", "lib/x/a.ts")?.doc.toString()).toBe("O");
  });
});

describe("동작(입력창·확인창 → 디스크 → 화면)", () => {
  const events: string[] = [];
  beforeEach(() => {
    calls.log = [];
    calls.fail = null;
    events.length = 0;
    const win = new EventTarget();
    win.addEventListener("aiterm:tree-reveal", (e) => events.push((e as CustomEvent<{ dir: string }>).detail.dir));
    vi.stubGlobal("window", win);
    useExtensions.setState({ loaded: true, enabled: { editor: true, stickman: true, usage: true } });
    useStore.setState({ focus: { worktreePath: W, source: "manual" }, viewer: null, fileTabs: [], activeTab: null, tabMemory: {}, toasts: [], prompt: null, confirm: null, fsTick: 0 });
  });

  it("새 파일: 앞뒤 빈칸을 지워 만들고, 폴더를 펼쳐 바로 연다. 같은 이름은 입력창에서 막는다", async () => {
    const done = newEntry(W, "src", false, ["a.ts"]);
    await tick();
    expect(st().prompt?.validate?.({ name: "A.ts" })).toBe("같은 이름이 이미 있어요: A.ts");
    expect(st().prompt?.validate?.({ name: "  b.ts " })).toBeNull();
    await answerPrompt({ name: "  b.ts " });
    expect(await done).toBe("src/b.ts");
    expect(calls.log).toEqual(["create src|b.ts|false"]);
    expect(events).toEqual(["src"]);
    expect(st().fileTabs.map((x) => x.viewer.rel)).toEqual(["src/b.ts"]);
    expect(st().fsTick).toBe(1);
  });
  it("새 md 파일은 빈 미리보기 대신 바로 쓸 수 있는 '내용'(편집)으로 연다. 오른쪽 아래(편집 꺼짐)도 같다", async () => {
    const done = newEntry(W, "", false, []);
    await answerPrompt({ name: "notes.md" });
    await done;
    expect(st().fileTabs.map((x) => x.viewer)).toEqual([{ kind: "file", rel: "notes.md", mode: "preview" }]);
    useExtensions.setState({ loaded: true, enabled: { editor: false, stickman: true, usage: true } });
    const off = newEntry(W, "", false, []);
    await answerPrompt({ name: "todo.md" });
    await off;
    expect(st().viewer).toEqual({ kind: "file", rel: "todo.md", mode: "preview" });
    // 트리에서 그냥 열 때는 md 를 미리보기로(원래대로)
    st().openViewer({ kind: "file", rel: "old.md", mode: "preview" });
    expect(st().viewer).toEqual({ kind: "file", rel: "old.md", mode: "render" });
  });
  it("새 폴더: 새 폴더까지 펼치고 열지는 않는다. 취소하면 아무것도 안 한다", async () => {
    const done = newEntry(W, "", true, []);
    await answerPrompt({ name: "docs" });
    expect(await done).toBe("docs");
    expect(events).toEqual(["docs"]);
    expect(st().fileTabs).toEqual([]);
    const cancel = newEntry(W, "", true, []);
    await answerPrompt(null);
    expect(await cancel).toBeNull();
    expect(calls.log).toEqual(["create |docs|true"]);
  });
  it("만들기 실패는 알림으로", async () => {
    calls.fail = "같은 이름이 이미 있습니다";
    const done = newEntry(W, "", false, []);
    await answerPrompt({ name: "a.ts" });
    expect(await done).toBeNull();
    expect(st().toasts.map((x) => x.text)).toEqual(["만들지 못했어요: 같은 이름이 이미 있습니다"]);
    expect(st().fileTabs).toEqual([]);
  });

  it("이름 바꾸기: 지금 이름을 확장자 앞까지 골라 두고, 열린 탭·수정이 새 이름을 따라간다", async () => {
    const t1 = tab("src/a.ts");
    useStore.setState({ fileTabs: [t1], activeTab: t1.id });
    setDraft(W, "src/a.ts", draft("고치던 것"));
    const done = renameEntry(W, "src/a.ts", false, ["a.ts", "b.ts"]);
    await tick();
    expect(st().prompt?.fields[0]).toMatchObject({ value: "a.ts", selectEnd: 1 });
    expect(st().prompt?.validate?.({ name: "b.ts" })).not.toBeNull();
    expect(st().prompt?.validate?.({ name: "A.ts" })).toBeNull();
    await answerPrompt({ name: "app.ts" });
    expect(await done).toBe("src/app.ts");
    expect(calls.log).toEqual(["rename src/a.ts|app.ts"]);
    expect(st().fileTabs.map((x) => x.viewer.rel)).toEqual(["src/app.ts"]);
    expect(st().activeTab).toBe(tab("src/app.ts").id);
    expect(getDraft(W, "src/a.ts")).toBeUndefined();
    expect(getDraft(W, "src/app.ts")?.doc.toString()).toBe("고치던 것");
  });
  it("이름 바꾸기: 그대로 두거나 취소하면 부르지 않고, 실패하면 탭·수정을 그대로 둔다", async () => {
    const same = renameEntry(W, "a.ts", false, ["a.ts"]);
    await answerPrompt({ name: " a.ts " });
    expect(await same).toBeNull();
    const t1 = tab("c.ts");
    useStore.setState({ fileTabs: [t1], activeTab: t1.id });
    setDraft(W, "c.ts", draft("C"));
    calls.fail = "같은 이름이 이미 있습니다";
    const failed = renameEntry(W, "c.ts", false, []);
    await answerPrompt({ name: "d.ts" });
    expect(await failed).toBeNull();
    expect(calls.log).toEqual(["rename c.ts|d.ts"]);
    expect(st().fileTabs).toEqual([t1]);
    expect(getDraft(W, "c.ts")?.doc.toString()).toBe("C");
    expect(st().toasts.map((x) => x.text)).toEqual(["이름을 바꾸지 못했어요: 같은 이름이 이미 있습니다"]);
  });

  it("휴지통: 확인창에 저장 안 한 수정을 적고, 옮기면 탭을 닫고 수정을 버린다", async () => {
    const [a, b] = [tab("keep.ts"), tab("old/x.ts")];
    useStore.setState({ fileTabs: [a, b], activeTab: b.id });
    setDraft(W, "old/x.ts", draft("X"));
    const done = trashEntry(W, "old", true);
    await tick();
    expect(st().confirm?.body).toContain("old 폴더를 안의 것까지 휴지통으로 옮겨요.");
    expect(st().confirm?.body).toContain("저장하지 않은 수정 1개는 사라져요:\n· old/x.ts");
    expect(st().confirm?.danger).toBe(true);
    await answerConfirm(true);
    expect(await done).toBe(true);
    expect(calls.log).toEqual(["trash old"]);
    expect(st().fileTabs).toEqual([a]);
    expect(st().activeTab).toBe(a.id);
    expect(getDraft(W, "old/x.ts")).toBeUndefined();
    expect(st().toasts.map((x) => x.text)).toEqual(["휴지통으로 옮겼어요: old"]);
  });
  it("휴지통: 취소하거나 실패하면 탭·수정을 그대로 둔다", async () => {
    const b = tab("y.ts");
    useStore.setState({ fileTabs: [b], activeTab: b.id });
    setDraft(W, "y.ts", draft("Y"));
    const cancel = trashEntry(W, "y.ts", false);
    await answerConfirm(false);
    expect(await cancel).toBe(false);
    expect(calls.log).toEqual([]);
    calls.fail = "휴지통으로 옮기지 못했어요: 권한 없음";
    const failed = trashEntry(W, "y.ts", false);
    await answerConfirm(true);
    expect(await failed).toBe(false);
    expect(st().fileTabs).toEqual([b]);
    expect(getDraft(W, "y.ts")?.doc.toString()).toBe("Y");
    expect(st().toasts.map((x) => x.text)).toEqual(["휴지통으로 옮기지 못했어요: 권한 없음"]);
  });
});
