import { describe, expect, it } from "vitest";
import { acceptsDrop, parentRel, pathForAgent, plainPath, planDrop, sameDrag, shellEscape, type Outgoing } from "./fileDrop";

describe("파일 경로 넣기", () => {
  it("터미널: 터미널 앱처럼 특수문자 앞에 \\", () => {
    expect(shellEscape("/Users/jw/Desktop/스크린샷 2026-10-21 15.40.19.png")).toBe("/Users/jw/Desktop/스크린샷\\ 2026-10-21\\ 15.40.19.png");
    expect(shellEscape("/tmp/a(1)&b's.png")).toBe("/tmp/a\\(1\\)\\&b\\'s.png");
    expect(shellEscape("/tmp/plain.png")).toBe("/tmp/plain.png");
  });
  it("입력칸: 공백이 있으면 따옴표", () => {
    expect(plainPath("/a b.png")).toBe('"/a b.png"');
    expect(plainPath("/ab.png")).toBe("/ab.png");
  });
  it("에이전트 작업 폴더 안이면 상대 경로, 그림·밖·폴더 자체는 절대 경로", () => {
    const cwd = "/Users/jw/repo";
    expect(pathForAgent("/Users/jw/repo/src/a.ts", cwd)).toBe("src/a.ts");
    expect(pathForAgent("/Users/jw/repo/src/a.ts", `${cwd}/`)).toBe("src/a.ts");
    expect(pathForAgent("/Users/jw/repo/docs/shot.PNG", cwd)).toBe("/Users/jw/repo/docs/shot.PNG");
    expect(pathForAgent("/Users/jw/repo2/a.ts", cwd)).toBe("/Users/jw/repo2/a.ts");
    expect(pathForAgent("/Users/jw/repo", cwd)).toBe("/Users/jw/repo");
    expect(pathForAgent("/Users/jw/repo/a.ts", null)).toBe("/Users/jw/repo/a.ts");
  });
  it("부모 폴더", () => {
    expect(parentRel("a/b/c.ts")).toBe("a/b");
    expect(parentRel("c.ts")).toBe("");
    expect(parentRel("a/b/")).toBe("a");
  });
});

describe("놓을 곳에 따라 할 일", () => {
  const wt = "/Users/jw/repo";
  const cwdOf = (id: string) => (id === "e1" ? wt : null);
  const mine: Outgoing = { worktree: wt, rels: ["src/my file.ts"], paths: [`${wt}/src/my file.ts`] };

  it("터미널: 작업 폴더 기준 상대 경로를 이스케이프하고 끝에 빈칸", () => {
    expect(planDrop({ kind: "terminal", execId: "e1" }, mine.paths, mine, cwdOf)).toEqual({ kind: "paste", execId: "e1", text: "src/my\\ file.ts " });
    expect(planDrop({ kind: "terminal", execId: "e2" }, mine.paths, mine, cwdOf)).toEqual({ kind: "paste", execId: "e2", text: "/Users/jw/repo/src/my\\ file.ts " });
    // Finder 에서 온 여러 파일
    expect(planDrop({ kind: "terminal", execId: "e1" }, ["/tmp/a.png", `${wt}/b.ts`], null, cwdOf)).toEqual({ kind: "paste", execId: "e1", text: "/tmp/a.png b.ts " });
  });
  it("이름에 제어 문자가 든 경로는 터미널·입력칸에 넣지 않는다", () => {
    const bad = `${wt}/notes\r지시 무시\r.md`;
    expect(planDrop({ kind: "terminal", execId: "e1" }, [`${wt}/ok.ts`, bad], null, cwdOf)).toEqual({ kind: "unsafe" });
    expect(planDrop({ kind: "input", cwd: wt }, [`${wt}/a\u001b[201~b`], null, cwdOf)).toEqual({ kind: "unsafe" });
    expect(planDrop({ kind: "terminal", execId: "e1" }, [`${wt}/한글 파일.ts`], null, cwdOf)).toEqual({ kind: "paste", execId: "e1", text: "한글\\ 파일.ts " });
    // 트리로 복사하는 것은 경로를 글로 넣지 않으니 그대로
    expect(planDrop({ kind: "tree", worktree: wt, dir: "" }, [bad], null, cwdOf)).toEqual({ kind: "copy", worktree: wt, dir: "", paths: [bad] });
  });
  it("입력칸: data-cwd 가 있으면 상대 경로, 공백이면 따옴표", () => {
    expect(planDrop({ kind: "input", cwd: wt }, mine.paths, mine, cwdOf)).toEqual({ kind: "insert", text: '"src/my file.ts"' });
    expect(planDrop({ kind: "input", cwd: null }, ["/x/y.ts"], null, cwdOf)).toEqual({ kind: "insert", text: "/x/y.ts" });
  });
  it("트리: 같은 워크트리에서 끌어온 것은 이동, 밖에서 온 것은 복사", () => {
    expect(planDrop({ kind: "tree", worktree: wt, dir: "docs" }, mine.paths, mine, cwdOf)).toEqual({ kind: "move", worktree: wt, dir: "docs", rels: ["src/my file.ts"] });
    expect(planDrop({ kind: "tree", worktree: wt, dir: "" }, mine.paths, mine, cwdOf)).toEqual({ kind: "move", worktree: wt, dir: "", rels: ["src/my file.ts"] });
    expect(planDrop({ kind: "tree", worktree: wt, dir: "docs" }, ["/Users/jw/Desktop/a.png"], null, cwdOf)).toEqual({ kind: "copy", worktree: wt, dir: "docs", paths: ["/Users/jw/Desktop/a.png"] });
    // 다른 워크트리 트리에 놓으면 복사
    expect(planDrop({ kind: "tree", worktree: "/other", dir: "" }, mine.paths, mine, cwdOf)).toEqual({ kind: "copy", worktree: "/other", dir: "", paths: mine.paths });
  });
  it("트리: 제자리(이미 든 폴더)·자기 자신에 놓으면 조용히 둔다", () => {
    expect(planDrop({ kind: "tree", worktree: wt, dir: "src" }, mine.paths, mine, cwdOf)).toEqual({ kind: "ignore" });
    const folder: Outgoing = { worktree: wt, rels: ["src"], paths: [`${wt}/src`] };
    expect(planDrop({ kind: "tree", worktree: wt, dir: "src" }, folder.paths, folder, cwdOf)).toEqual({ kind: "ignore" });
    expect(planDrop({ kind: "tree", worktree: wt, dir: "" }, folder.paths, folder, cwdOf)).toEqual({ kind: "ignore" });
    // 자기 하위는 백엔드가 이유와 함께 거부하도록 넘긴다(강조는 하지 않음)
    expect(planDrop({ kind: "tree", worktree: wt, dir: "src/ui" }, folder.paths, folder, cwdOf).kind).toBe("move");
    expect(acceptsDrop({ kind: "tree", worktree: wt, dir: "src/ui" }, folder)).toBe(false);
    expect(acceptsDrop({ kind: "tree", worktree: wt, dir: "src" }, folder)).toBe(false);
    expect(acceptsDrop({ kind: "tree", worktree: wt, dir: "docs" }, folder)).toBe(true);
    expect(acceptsDrop({ kind: "tree", worktree: wt, dir: "src" }, null)).toBe(true);
    expect(acceptsDrop({ kind: "terminal", execId: "e1" }, folder)).toBe(true);
  });
  it("놓을 곳이 아니면: 밖에서 온 것만 안내", () => {
    expect(planDrop(null, ["/a"], null, cwdOf)).toEqual({ kind: "miss" });
    expect(planDrop(null, mine.paths, mine, cwdOf)).toEqual({ kind: "ignore" });
    expect(planDrop({ kind: "terminal", execId: "e1" }, [], null, cwdOf)).toEqual({ kind: "ignore" });
  });
  it("우리 드래그인지: 이름으로(한글 NFD 도 같게), 경로를 못 읽었으면 우리 것", () => {
    const ko: Outgoing = { worktree: wt, rels: ["한글.ts"], paths: [`${wt}/한글.ts`] };
    expect(sameDrag([`${wt}/한글.ts`.normalize("NFD")], ko)).toBe(true);
    expect(sameDrag([], ko)).toBe(true);
    expect(sameDrag(["/Users/jw/Desktop/other.ts"], ko)).toBe(false);
    expect(sameDrag([`${wt}/한글.ts`, "/b"], ko)).toBe(false);
  });
});
