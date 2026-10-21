import { describe, expect, it } from "vitest";
import type { ChatEvent } from "./api";
import { foldChatEvents } from "./panels/ChatView";

describe("foldChatEvents", () => {
  it("merges tool start and result by id and marks permission resolution", () => {
    const ev: ChatEvent[] = [
      { kind: "user", text: "만들어 줘" },
      { kind: "tool", id: "t1", name: "Write", summary: "/r/a.txt", status: "running", output: null },
      { kind: "permission", requestId: "p1", tool: "Write", summary: "a.txt", input: {} },
      { kind: "permissionResolved", requestId: "p1", allowed: true },
      { kind: "tool", id: "t1", name: "", summary: "", status: "ok", output: "created" },
      { kind: "assistant", text: "완료" },
      { kind: "turnEnd", costUsd: 0.01, isError: false, text: null },
    ];
    const items = foldChatEvents(ev);
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "permission", "assistant", "turnEnd"]);
    const tool = items[1] as Extract<ReturnType<typeof foldChatEvents>[number], { kind: "tool" }>;
    expect(tool.name).toBe("Write");
    expect(tool.summary).toBe("/r/a.txt");
    expect(tool.status).toBe("ok");
    expect(tool.output).toBe("created");
    expect((items[2] as { resolved: boolean | null }).resolved).toBe(true);
  });
  it("keeps tools without id separate and notes process exit", () => {
    const items = foldChatEvents([
      { kind: "tool", id: "", name: "shell", summary: "ls", status: "ok", output: "a" },
      { kind: "tool", id: "", name: "shell", summary: "pwd", status: "ok", output: "/" },
      { kind: "exit", code: 0 },
    ]);
    expect(items).toHaveLength(3);
    expect(items[2].kind).toBe("note");
  });
});
