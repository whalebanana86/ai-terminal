import { describe, expect, it } from "vitest";
import { absPath, crc32, pngWithDpi, transferMessages } from "./treeDrag";

const none = { done: [], renamed: [], unchanged: 0, failed: [], skipped: 0 };

describe("트리에서 끌기", () => {
  it("절대 경로", () => {
    expect(absPath("/Users/jw/repo/", "src/a.ts")).toBe("/Users/jw/repo/src/a.ts");
  });

  it("CRC32 는 PNG 표준 값과 같다", () => {
    expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
  });

  it("PNG 에 해상도(pHYs) 조각을 IHDR 뒤에 넣는다", () => {
    // 서명 + IHDR(내용 13바이트) + IEND 만 있는 가짜 PNG
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const ihdr = [0, 0, 0, 13, ...new TextEncoder().encode("IHDR"), ...new Array(13).fill(1), 0, 0, 0, 0];
    const iend = [0, 0, 0, 0, ...new TextEncoder().encode("IEND"), 0xae, 0x42, 0x60, 0x82];
    const png = Uint8Array.from([...sig, ...ihdr, ...iend]);
    const out = pngWithDpi(png, 144);
    expect(out.length).toBe(png.length + 21);
    const v = new DataView(out.buffer);
    expect(v.getUint32(33)).toBe(9);
    expect(new TextDecoder().decode(out.slice(37, 41))).toBe("pHYs");
    expect(v.getUint32(41)).toBe(5669); // 144dpi = 5669 점/m
    expect(out[49]).toBe(1);
    expect(v.getUint32(50)).toBe(crc32(out.slice(37, 50)));
    expect([...out.slice(54)]).toEqual(iend);
    // PNG 가 아니면 그대로
    const junk = new Uint8Array([1, 2, 3]);
    expect(pngWithDpi(junk, 144)).toBe(junk);
  });

  it("결과 알림: 성공·비켜 놓기·건너뜀·실패", () => {
    expect(transferMessages("copy", "docs", { ...none, done: ["docs/a 2.txt", "docs/b.png"], renamed: [{ from: "a.txt", to: "a 2.txt" }], skipped: 1 })).toEqual({
      ok: "docs 폴더에 복사했어요: a 2.txt, b.png · 같은 이름이 있어 새 이름으로 두었어요: a 2.txt · 특수 파일 1개는 건너뛰었어요",
      error: null,
    });
    expect(transferMessages("move", "src", { ...none, done: ["src/a.ts"] })).toEqual({ ok: "src 폴더로 옮겼어요: a.ts", error: null });
    expect(transferMessages("move", "src", { ...none, failed: [{ name: "b.ts", reason: "그 폴더에 같은 이름이 이미 있습니다" }, { name: "c.ts", reason: "x" }] })).toEqual({
      ok: null,
      error: "옮기지 못했어요: b.ts — 그 폴더에 같은 이름이 이미 있습니다 (외 1개)",
    });
    expect(transferMessages("copy", "repo", { ...none, done: ["a", "b", "c", "d", "e"] }).ok).toBe("repo 폴더에 복사했어요: a, b, c 외 2개");
    expect(transferMessages("move", "src", { ...none, unchanged: 1 })).toEqual({ ok: null, error: null });
  });
});
