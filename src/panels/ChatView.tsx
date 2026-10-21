import { Channel } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, type ChatEvent, type ChatInfo, type Transcript } from "../api";
import { useStore } from "../store";

/** 도구 실행: 시작 이벤트와 결과 이벤트를 같은 id 로 합친 것 */
interface ToolItem {
  kind: "tool";
  id: string;
  name: string;
  summary: string;
  status: "running" | "ok" | "error";
  output: string | null;
}
type Item =
  | { kind: "user" | "assistant" | "error" | "note"; text: string }
  | ToolItem
  | { kind: "permission"; requestId: string; tool: string; summary: string; description: string | null; resolved: boolean | null }
  | { kind: "turnEnd"; costUsd: number | null; isError: boolean; text: string | null };

/** 이벤트 목록 → 화면 항목 (순수 함수, 테스트 대상) */
export function foldChatEvents(events: ChatEvent[]): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, ToolItem>();
  const perms = new Map<string, Extract<Item, { kind: "permission" }>>();
  for (const e of events) {
    switch (e.kind) {
      case "user":
      case "assistant":
      case "error":
        items.push({ kind: e.kind, text: e.text });
        break;
      case "tool": {
        const prev = e.id ? tools.get(e.id) : undefined;
        if (prev) {
          // 결과(또는 완료) 이벤트: 이름·요약은 시작 때 것을 유지
          prev.status = e.status;
          if (e.output !== null) prev.output = e.output;
          if (e.summary) prev.summary = e.summary;
        } else {
          const t: ToolItem = { kind: "tool", id: e.id, name: e.name, summary: e.summary, status: e.status, output: e.output };
          if (e.id) tools.set(e.id, t);
          items.push(t);
        }
        break;
      }
      case "permission": {
        const p = { kind: "permission" as const, requestId: e.requestId, tool: e.tool, summary: e.summary, description: e.description, resolved: null };
        perms.set(e.requestId, p);
        items.push(p);
        break;
      }
      case "permissionResolved": {
        const p = perms.get(e.requestId);
        if (p) p.resolved = e.allowed;
        break;
      }
      case "turnEnd":
        items.push({ kind: "turnEnd", costUsd: e.costUsd, isError: e.isError, text: e.text });
        break;
      case "exit":
        items.push({ kind: "note", text: `에이전트 프로세스가 끝났습니다 (코드 ${e.code ?? "?"}).` });
        break;
      default:
        break;
    }
  }
  return items;
}

export function ChatView({ chat }: { chat: ChatInfo }) {
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toast = useStore((s) => s.toast);
  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEvents([]);
    const ch = new Channel<ChatEvent>();
    const buf: ChatEvent[] = [];
    let frame = 0;
    // 이벤트가 몰려도 한 프레임에 한 번만 그린다.
    ch.onmessage = (e) => {
      buf.push(e);
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          const batch = buf.splice(0);
          setEvents((prev) => [...prev, ...batch]);
        });
    };
    let sinkId: number | null = null;
    let disposed = false;
    api.chatAttach(chat.id, ch).then(
      (id) => (disposed ? void api.chatDetach(chat.id, id) : (sinkId = id)),
      (e) => toast("error", errorText(e)),
    );
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      if (sinkId !== null) void api.chatDetach(chat.id, sinkId);
    };
  }, [chat.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => foldChatEvents(events), [events]);
  // 이어가는 대화면 지난 기록을 위에 접어 둔다(한 흐름으로 보이게).
  const [past, setPast] = useState<Transcript | null>(null);
  const [showPast, setShowPast] = useState(false);
  useEffect(() => {
    setPast(null);
    setShowPast(false);
    if (chat.sessionId) api.transcript(chat.sessionId).then(setPast, () => setPast(null));
  }, [chat.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const pastItems = (past?.items ?? []).filter((i) => i.kind !== "tool");
  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [items]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setSending(true);
    try {
      await api.chatSend(chat.id, t);
      setText("");
      stick.current = true;
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setSending(false);
    }
  };
  const answer = async (requestId: string, allow: boolean) => {
    try {
      await api.chatPermission(chat.id, requestId, allow);
    } catch (e) {
      toast("error", errorText(e));
    }
  };
  const pendingPermission = items.some((i) => i.kind === "permission" && i.resolved === null);

  return (
    <div className="chat" data-testid="chat-view">
      <div className="chat-bar">
        <span className="muted small">
          {chat.agent === "claude" ? `허락 범위: ${modeLabel(chat.mode)}` : `허락 범위: ${chat.mode === "workspace-write" ? "이 워크트리 안에서 쓰기" : "읽기만"}`}
          {!chat.alive && " · 프로세스 종료됨"}
        </span>
        <span className="spacer" />
        {chat.busy && (
          <button className="btn btn-small" onClick={() => api.chatInterrupt(chat.id).catch((e) => toast("error", errorText(e)))}>
            중단
          </button>
        )}
      </div>
      <div
        className="chat-list"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {pastItems.length > 0 && (
          <div className="past">
            <button className="past-toggle" onClick={() => setShowPast(!showPast)} aria-expanded={showPast}>
              {showPast ? "▾" : "▸"} 이전 대화 {pastItems.length}개
            </button>
            {showPast &&
              pastItems.map((i, n) => (
                <div key={n} className={`msg msg-${i.kind} past-msg`}>
                  <div className="msg-text">{i.text}</div>
                </div>
              ))}
            <div className="resume-divider">
              <span>여기서부터 이어감</span>
            </div>
          </div>
        )}
        {items.length === 0 && <div className="muted pad">메시지를 보내면 에이전트가 이 워크트리에서 이어서 작업해요.</div>}
        {items.map((it, i) => {
          switch (it.kind) {
            case "user":
              return (
                <div key={i} className="msg msg-user">
                  <div className="msg-text">{it.text}</div>
                </div>
              );
            case "assistant":
              return (
                <div key={i} className="msg msg-assistant">
                  <div className="msg-text">{it.text}</div>
                </div>
              );
            case "error":
              return (
                <div key={i} className="banner banner-error">
                  {it.text}
                </div>
              );
            case "note":
              return (
                <div key={i} className="muted small pad">
                  {it.text}
                </div>
              );
            case "tool": {
              const key = it.id || String(i);
              const expanded = open.has(key);
              return (
                <div key={i} className={`chat-tool st-${it.status}`}>
                  <button
                    className="chat-tool-head"
                    onClick={() => {
                      const n = new Set(open);
                      if (expanded) n.delete(key);
                      else n.add(key);
                      setOpen(n);
                    }}
                    aria-expanded={expanded}
                  >
                    <span className="tool-dot" />
                    <span className="tool-name">{it.name || "도구"}</span>
                    <span className="tool-text">{it.summary}</span>
                  </button>
                  {expanded && it.output && <pre className="chat-tool-out">{it.output}</pre>}
                </div>
              );
            }
            case "permission":
              return (
                <div key={i} className={`perm${it.resolved === null ? " pending" : ""}`} data-testid="permission-card">
                  <div>
                    <b>{it.tool}</b> 사용 허락을 요청합니다
                  </div>
                  {/* 실제로 실행될 명령·경로·내용. 모델이 쓴 설명은 참고로만 아래에 둔다. */}
                  <pre className="perm-summary">{it.summary}</pre>
                  {it.description && it.description !== it.summary && <div className="muted small">모델 설명: {it.description}</div>}
                  {it.resolved === null ? (
                    <div className="perm-actions">
                      <button className="btn btn-small btn-danger" onClick={() => answer(it.requestId, false)}>
                        거부
                      </button>
                      <button className="btn btn-small btn-primary" onClick={() => answer(it.requestId, true)} data-action="allow">
                        허용
                      </button>
                    </div>
                  ) : (
                    <div className="muted small">{it.resolved ? "허용함" : "거부함"}</div>
                  )}
                </div>
              );
            case "turnEnd":
              return (
                <div
                  key={i}
                  className={`turn-end${it.isError ? " err" : ""}`}
                  title={it.costUsd != null ? `CLI 가 보고한 API 환산 누적 비용 $${it.costUsd.toFixed(3)} (구독 사용 시 실제 청구와 다름)` : undefined}
                >
                  {it.isError ? `오류로 끝남${it.text ? `: ${it.text}` : ""}` : "응답 끝"}
                </div>
              );
          }
        })}
        {chat.busy && !pendingPermission && <div className="typing">답하는 중…</div>}
        <div ref={bottom} />
      </div>
      <div className="chat-input">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={chat.busy ? "에이전트가 답하는 중입니다" : "메시지 (Enter 보내기, Shift+Enter 줄바꿈)"}
          rows={3}
          disabled={!chat.alive}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!chat.busy && !sending) void send();
            }
          }}
          data-testid="chat-input"
        />
        <button className="btn btn-primary" disabled={chat.busy || sending || !text.trim() || !chat.alive} onClick={send}>
          보내기
        </button>
      </div>
    </div>
  );
}

function modeLabel(m: string) {
  switch (m) {
    case "acceptEdits":
      return "파일 편집은 자동 허락";
    case "plan":
      return "계획만 세우기 (수정 안 함)";
    case "bypassPermissions":
      return "모두 허락 (위험)";
    default:
      return "도구마다 허락 묻기";
  }
}
