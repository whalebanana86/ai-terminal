import { describe, expect, it } from "vitest";
import { aiAgentOf, aiAgentsIn, parseIdentity } from "./aiAuthors";

describe("parseIdentity", () => {
  it("이름 <이메일>", () => {
    expect(parseIdentity("Claude Opus 5.5 <noreply@anthropic.com>")).toEqual({ name: "Claude Opus 5.5", email: "noreply@anthropic.com" });
    expect(parseIdentity("  김 개발 <kim@x.kr>  ")).toEqual({ name: "김 개발", email: "kim@x.kr" });
  });
  it("꺾쇠가 없으면 이메일 또는 이름", () => {
    expect(parseIdentity("noreply@anthropic.com")).toEqual({ name: "", email: "noreply@anthropic.com" });
    expect(parseIdentity("Kim")).toEqual({ name: "Kim", email: "" });
  });
});

describe("aiAgentOf", () => {
  it("Claude", () => {
    expect(aiAgentOf("Claude Opus 5.5 <noreply@anthropic.com>")).toBe("claude");
    expect(aiAgentOf("Claude <claude@users.noreply.github.com>")).toBe("claude");
    expect(aiAgentOf("noreply@anthropic.com")).toBe("claude");
    expect(aiAgentOf({ name: "claude", email: "" })).toBe("claude");
    expect(aiAgentOf("Anthropic <x@y.z>")).toBe("claude");
  });
  it("Codex", () => {
    expect(aiAgentOf("Codex <noreply@openai.com>")).toBe("codex");
    expect(aiAgentOf("OpenAI Codex <codex@openai.com>")).toBe("codex");
    expect(aiAgentOf("OpenAI <noreply@openai.com>")).toBe("codex");
    expect(aiAgentOf("chatgpt-codex-connector[bot] <199175422+chatgpt-codex-connector[bot]@users.noreply.github.com>")).toBe("codex");
  });
  it("Copilot", () => {
    expect(aiAgentOf("Copilot <175728472+Copilot@users.noreply.github.com>")).toBe("copilot");
    expect(aiAgentOf("github-copilot[bot] <x@users.noreply.github.com>")).toBe("copilot");
    expect(aiAgentOf("copilot-swe-agent[bot] <198982749+Copilot@users.noreply.github.com>")).toBe("copilot");
  });
  it("Cursor", () => {
    expect(aiAgentOf("Cursor Agent <cursoragent@cursor.com>")).toBe("cursor");
    expect(aiAgentOf("cursoragent@cursor.com")).toBe("cursor");
    expect(aiAgentOf("Cursor <x@y.z>")).toBe("cursor");
  });
  it("Gemini", () => {
    expect(aiAgentOf("Gemini <gemini@google.com>")).toBe("gemini");
    expect(aiAgentOf("gemini-code-assist[bot] <176961590+gemini-code-assist[bot]@users.noreply.github.com>")).toBe("gemini");
    expect(aiAgentOf("google-labs-jules[bot] <161369871+google-labs-jules[bot]@users.noreply.github.com>")).toBe("gemini");
    expect(aiAgentOf("Google <noreply@google.com>")).toBe("gemini");
  });
  it("사람은 AI 가 아니다(회사 주소·비슷한 이름 포함)", () => {
    expect(aiAgentOf("Kim <k@x>")).toBeNull();
    expect(aiAgentOf("Claudette Lee <cl@x.com>")).toBeNull();
    expect(aiAgentOf("Jane Doe <jane@anthropic.com>")).toBeNull();
    expect(aiAgentOf("Sam <sam@openai.com>")).toBeNull();
    expect(aiAgentOf("Lee <lee@google.com>")).toBeNull();
    expect(aiAgentOf("Dev <dev@cursor.com>")).toBeNull();
    expect(aiAgentOf("Googler <12+googler@users.noreply.github.com>")).toBeNull();
    expect(aiAgentOf("dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>")).toBeNull();
    expect(aiAgentOf("")).toBeNull();
  });
});

describe("aiAgentsIn", () => {
  it("겹치지 않게, 나온 순서대로", () => {
    expect(aiAgentsIn([])).toEqual([]);
    expect(aiAgentsIn(["Kim <k@x>"])).toEqual([]);
    expect(aiAgentsIn(["Kim <k@x>", "Codex <noreply@openai.com>", "Claude <noreply@anthropic.com>", "Claude Opus 5.5 <noreply@anthropic.com>"])).toEqual(["codex", "claude"]);
  });
});
