import { describe, expect, it } from "vitest";
import { plainPath, shellEscape } from "./fileDrop";

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
});
