import { describe, expect, it } from "vitest";
import type { MemoryHit, TranscriptItem } from "./api";
import { composeMemory, turnsFromTranscript } from "./memoryCompose";

const item = (kind: TranscriptItem["kind"], text: string, timestamp = 1): TranscriptItem => ({ kind, text, tool: kind === "tool" ? "Bash" : null, timestamp, isError: false });
const hit = (over: Partial<MemoryHit>): MemoryHit => ({
  id: 1,
  session: "claude:a",
  agent: "claude",
  ts: Date.UTC(2026, 9, 21, 12),
  project: "app",
  user: "로그인 토큰 만료 버그",
  assistant: "refresh 처리에서 만료를 잡게 고쳤습니다.",
  files: ["/w/src/auth.rs"],
  score: 0.8,
  ...over,
});

describe("turnsFromTranscript", () => {
  it("사람 요청마다 묶고 도구 항목은 뺀다", () => {
    const turns = turnsFromTranscript([
      item("assistant", "요청 전 답(버림)"),
      item("user", "버그 고쳐 줘"),
      item("tool", "cargo test"),
      item("assistant", "찾았습니다"),
      item("assistant", "고쳤습니다"),
      item("user", "커밋해"),
    ]);
    expect(turns).toEqual([
      { user: "버그 고쳐 줘", assistant: "찾았습니다\n\n고쳤습니다", ts: 1 },
      { user: "커밋해", assistant: "", ts: 1 },
    ]);
  });
});

describe("composeMemory", () => {
  it("넣을 것이 없으면 빈 글", () => {
    expect(composeMemory({ title: "x", recent: [], hits: [] })).toBe("");
  });

  it("직전 대화와 관련 기억을 참고 자료로 감싼다", () => {
    const text = composeMemory({ title: "인증 정리", recent: [{ user: "테스트 추가해", assistant: "추가했습니다", ts: 1 }], hits: [hit({})] });
    expect(text.startsWith("<previous-work>\n아래는 지난 작업 기록입니다.")).toBe(true);
    expect(text.endsWith("</previous-work>")).toBe(true);
    expect(text).toContain("## 직전 대화 — 인증 정리\n[사용자] 테스트 추가해\n[AI] 추가했습니다\n");
    expect(text).toContain("- [2026-10-21 · app] 요청: 로그인 토큰 만료 버그 / 결과: refresh 처리에서 만료를 잡게 고쳤습니다. / 수정한 파일: auth.rs\n");
  });

  it("상한 안에서 가장 최근 대화와 위쪽 기억부터 남긴다", () => {
    const long = "가".repeat(1400);
    const recent = [1, 2, 3, 4, 5, 6].map((n) => ({ user: `요청${n}`, assistant: long, ts: n }));
    const hits = [1, 2, 3, 4, 5].map((n) => hit({ id: n, user: `기억${n}`, assistant: long }));
    const text = composeMemory({ title: "t", recent, hits, limit: 4000 });
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain("요청6");
    expect(text).not.toContain("요청1");
    expect(text.indexOf("요청5")).toBeLessThan(text.indexOf("요청6"));
    // 대화가 상한을 다 쓰면 기억은 들어갈 만큼만
    const onlyHits = composeMemory({ title: "t", recent: [], hits, limit: 2000 });
    expect(onlyHits).toContain("기억1");
    expect(onlyHits).not.toContain("기억5");
  });
});
