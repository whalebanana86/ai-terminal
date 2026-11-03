import { describe, expect, it } from "vitest";
import { isMarkdown } from "./fileIcons";
import { fileUrl, linkTarget, resolveRel, slug } from "./markdown";

// renderMarkdown(DOMPurify)은 DOM 이 있어야 해서 시험 앱에서 확인한다(docs/TEST_REPORT.md)
describe("md 미리보기 도우미", () => {
  it("md 파일만 미리보기", () => {
    expect(["README.md", "docs/a.MD", "x.markdown", "y.mkd"].every(isMarkdown)).toBe(true);
    expect([".md", "docs/.md", "a.md.txt", "md", "a.mdx"].some(isMarkdown)).toBe(false);
  });

  it("제목 앵커는 GitHub 처럼(한글 그대로)", () => {
    expect(slug("설치 방법")).toBe("설치-방법");
    expect(slug("Files: content, diff & images")).toBe("files-content-diff--images");
    expect(slug("`api` 쓰기!")).toBe("api-쓰기");
  });

  it("상대 경로는 md 파일 폴더 기준, 워크트리 밖은 null", () => {
    expect(resolveRel("docs/guide.md", "img/a.png")).toBe("docs/img/a.png");
    expect(resolveRel("docs/guide.md", "../README.md#설치")).toBe("README.md");
    expect(resolveRel("docs/guide.md", "./%EA%B7%B8%EB%A6%BC.png")).toBe("docs/그림.png");
    expect(resolveRel("docs/guide.md", "/src/main.ts")).toBe("src/main.ts");
    expect(resolveRel("README.md", "../../etc/passwd")).toBeNull();
    expect(resolveRel("README.md", "#only")).toBeNull();
  });

  it("링크 종류: 앵커·바깥 주소·저장소 파일, 그 밖의 주소는 열지 않는다", () => {
    expect(linkTarget("README.md", "#설치")).toEqual({ kind: "anchor", id: "설치" });
    expect(linkTarget("README.md", "https://example.com/a")).toEqual({ kind: "external", url: "https://example.com/a" });
    expect(linkTarget("README.md", "mailto:a@example.com")).toEqual({ kind: "external", url: "mailto:a@example.com" });
    expect(linkTarget("docs/a.md", "b.md")).toEqual({ kind: "file", rel: "docs/b.md" });
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "tauri://localhost/x", "data:text/html,x", null, "../../x"]) {
      expect(linkTarget("docs/a.md", bad).kind, String(bad)).toBe("none");
    }
  });

  it("브라우저용 file:// 주소는 경로 마디마다 인코딩", () => {
    expect(fileUrl("/Users/a/내 저장소/", "docs/그림 #1.png")).toBe("file:///Users/a/%EB%82%B4%20%EC%A0%80%EC%9E%A5%EC%86%8C/docs/%EA%B7%B8%EB%A6%BC%20%231.png");
  });
});
