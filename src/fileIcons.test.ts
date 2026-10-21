import { describe, expect, it } from "vitest";
import { fileIconSpec, folderIconSpec } from "./fileIcons";

describe("fileIconSpec", () => {
  const kind = (n: string) => fileIconSpec(n).kind;
  it("확장자", () => {
    expect(kind("App.tsx")).toBe("typescript");
    expect(kind("main.rs")).toBe("rust");
    expect(kind("data.JSON")).toBe("json");
    expect(kind("logo.svg")).toBe("image");
    expect(kind("notes.md")).toBe("text");
    expect(kind("run.sh")).toBe("shell");
    expect(kind("Cargo.lock")).toBe("lock");
  });
  it("특별한 이름이 확장자보다 먼저", () => {
    expect(kind("package.json")).toBe("npm");
    expect(kind("README.md")).toBe("readme");
    expect(kind("LICENSE")).toBe("license");
    expect(kind(".env.local")).toBe("env");
    expect(kind(".gitignore")).toBe("git");
    expect(kind("tsconfig.node.json")).toBe("tsconfig");
    expect(kind("vite.config.ts")).toBe("build-config");
    expect(kind("Dockerfile")).toBe("docker");
    expect(kind("CLAUDE.md")).toBe("agent-rules");
  });
  it("모르는 것은 일반 파일", () => {
    expect(kind("Makefile2")).toBe("file");
    expect(kind("noext")).toBe("file");
    expect(kind(".hidden")).toBe("file");
  });
  it("폴더", () => {
    expect(folderIconSpec("src", false).kind).toBe("folder");
    expect(folderIconSpec(".git", true).kind).toBe("git-folder");
  });
});
