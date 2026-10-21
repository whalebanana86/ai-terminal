import { describe, expect, it } from "vitest";
import { HangulBuffer, isHangul } from "./hangulInput";

/** 실제 앱에서 기록한 WebKit 이벤트 순서("한글 안녕⏎")를 그대로 재생한다. */
function run(events: (["i", string, string | null] | ["k", number])[]) {
  const sent: string[] = [];
  const shown: string[] = [];
  const passed: string[] = [];
  const b = new HangulBuffer((t) => sent.push(t), (t) => shown.push(t));
  for (const e of events) {
    if (e[0] === "i") {
      if (!b.input(e[1], e[2])) passed.push(`${e[1]}:${e[2]}`);
    } else if (!b.key(e[1])) passed.push(`key:${e[1]}`);
  }
  return { sent, shown, passed, pending: b.pending };
}

describe("HangulBuffer", () => {
  it("바꿔치기 방식 입력을 완성된 글자로 보낸다", () => {
    const r = run([
      ["i", "insertText", "ㅎ"], ["k", 229],
      ["i", "insertReplacementText", "하"], ["k", 229],
      ["i", "insertReplacementText", "한"], ["k", 229],
      ["i", "insertReplacementText", "한"], ["i", "insertText", "ㄱ"], ["k", 229],
      ["i", "insertReplacementText", "그"], ["k", 229],
      ["i", "insertReplacementText", "글"], ["k", 229],
      ["i", "insertReplacementText", "글"], ["k", 32], ["i", "insertText", " "],
      ["i", "insertText", "ㅇ"], ["k", 229],
      ["i", "insertReplacementText", "아"], ["k", 229],
      ["i", "insertReplacementText", "안"], ["k", 229],
      ["i", "insertReplacementText", "안"], ["i", "insertText", "ㄴ"], ["k", 229],
      ["i", "insertReplacementText", "녀"], ["k", 229],
      ["i", "insertReplacementText", "녕"], ["k", 229],
      ["i", "insertReplacementText", "녕"], ["k", 13],
    ]);
    expect(r.sent).toEqual(["한", "글", "안", "녕"]);
    // 띄어쓰기·Enter 는 xterm 이 원래대로 보낸다(조합 글자를 먼저 보낸 뒤)
    expect(r.passed).toEqual(["key:32", "insertText: ", "key:13"]);
    expect(r.pending).toBe("");
    expect(r.shown).toContain("하");
  });
  it("조합 중 지우기는 터미널로 보내지 않는다", () => {
    const r = run([["i", "insertText", "ㅎ"], ["i", "deleteContentBackward", null], ["k", 13]]);
    expect(r.sent).toEqual([]);
    expect(r.passed).toEqual(["key:13"]);
    // 실제 기록: 자모 하나 뒤 Backspace 는 입력기가 keyCode 8 로 넘긴다
    const r2 = run([["i", "insertText", "ㅎ"], ["i", "insertReplacementText", "ㅎ"], ["k", 8], ["k", 8]]);
    expect(r2.sent).toEqual([]);
    expect(r2.passed).toEqual(["key:8"]); // 두 번째 Backspace 는 원래대로 터미널에
  });
  it("한글 뒤 영문·숫자는 조합 글자를 먼저 보낸다", () => {
    const r = run([["i", "insertText", "ㅎ"], ["i", "insertReplacementText", "하"], ["k", 65]]);
    expect(r.sent).toEqual(["하"]);
  });
  it("isHangul", () => {
    expect(isHangul("한ㄱㅏ")).toBe(true);
    expect(isHangul("a한")).toBe(false);
    expect(isHangul(" ")).toBe(false);
  });
});
