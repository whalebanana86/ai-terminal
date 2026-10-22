import { Text } from "@codemirror/state";
import { beforeEach, describe, expect, it, vi } from "vitest";

const saved = new Map<string, boolean>();
let confirmAnswer = true;
vi.mock("../api", () => ({
  api: {
    extensionsList: async () => [...saved].map(([id, enabled]) => ({ id, enabled })),
    // Rust 처럼: 파일 편집을 켤 때는 확인창 대답에 따른다
    extensionSet: async (id: string, enabled: boolean) => {
      if (!(id === "editor" && enabled && !confirmAnswer)) saved.set(id, enabled);
      return [...saved].map(([i, e]) => ({ id: i, enabled: e }));
    },
  },
}));

import { EXTENSIONS, useExtensions } from ".";
import { draftCount, dropDraft, getDraft, setDraft } from "./editor/drafts";
import { agentBranchOf, isEditBranch } from "./editor/editWorktree";

describe("확장 기능", () => {
  beforeEach(() => {
    saved.clear();
    confirmAnswer = true;
  });

  it("파일 편집은 꺼진 채, 스틱맨·구독 한도는 켜진 채로 시작한다", async () => {
    expect(Object.fromEntries(EXTENSIONS.map((e) => [e.id, e.defaultEnabled]))).toEqual({ editor: false, stickman: true, usage: true });
    await useExtensions.getState().load();
    expect(useExtensions.getState().enabled).toEqual({ editor: false, stickman: true, usage: true });
    expect(useExtensions.getState().loaded).toBe(true);
  });

  it("맥 확인창에서 취소하면 꺼진 채로 남는다", async () => {
    confirmAnswer = false;
    expect(await useExtensions.getState().set("editor", true)).toBe(false);
    expect(useExtensions.getState().enabled.editor).toBe(false);
    confirmAnswer = true;
    expect(await useExtensions.getState().set("editor", true)).toBe(true);
    expect(await useExtensions.getState().set("stickman", false)).toBe(false);
    expect(useExtensions.getState().enabled).toEqual({ editor: true, stickman: false, usage: true });
  });

  it("편집기는 파일 보기의 '내용' 을, 스틱맨은 위쪽 막대를, 구독 한도는 상태줄을 쓴다", () => {
    const by = Object.fromEntries(EXTENSIONS.map((e) => [e.id, e]));
    expect(by.editor.fileModes?.map((m) => m.key)).toEqual(["ext:editor"]);
    // 따로 탭을 더하지 않고 '내용' 을 편집 화면으로 바꾼다
    expect(by.editor.fileModes?.[0].replaces).toBe("preview");
    expect(by.editor.fileModes?.[0].available({ rel: "a.png", isImage: true })).toBe(false);
    expect(by.stickman.topbar).toBeTruthy();
    expect(by.usage.statusbar).toBeTruthy();
  });
});

describe("저장하지 않은 편집", () => {
  it("파일마다 따로 남고 지우면 사라진다", () => {
    const d = { doc: Text.of(["a", "b"]), hash: "h", crlf: false, bom: false };
    setDraft("/w", "a.ts", d);
    setDraft("/w", "b.ts", d);
    setDraft("/w2", "a.ts", d);
    expect(draftCount()).toBe(3);
    expect(getDraft("/w", "a.ts")?.doc.toString()).toBe("a\nb");
    dropDraft("/w", "a.ts");
    expect(getDraft("/w", "a.ts")).toBeUndefined();
    expect(getDraft("/w2", "a.ts")).toBeDefined();
  });
});

describe("내 수정 워크트리 브랜치", () => {
  it("edit/<AI 브랜치> 만 내 수정 브랜치로 본다", () => {
    expect(isEditBranch("edit/feature/x")).toBe(true);
    expect(agentBranchOf("edit/feature/x")).toBe("feature/x");
    expect(isEditBranch("edit/")).toBe(false);
    expect(isEditBranch("editor")).toBe(false);
    expect(isEditBranch(null)).toBe(false);
  });
});
