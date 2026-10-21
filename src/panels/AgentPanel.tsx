import { open } from "@tauri-apps/plugin-dialog";
import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { api, errorText, externalRunning, type Agent, type ChatInfo, type LinkedSession, type LiveRun, type Transcript, type WorktreeStatus } from "../api";
import { AgentBadge, Empty } from "../components/Overlays";
import { activity, baseName, branchLabel, branchState, clientLabel, externalRunOf, kindLabel, kindLetter, relativeTime, relativeTo } from "../logic";
import { useSelectedSession, useStore } from "../store";
import { PanelHead } from "./GitPanel";
import { ChatView } from "./ChatView";
// 터미널(xterm + WebGL, 약 460KB)은 실제로 띄울 때만 불러온다.
const TerminalView = lazy(() => import("./TerminalView").then((m) => ({ default: m.TerminalView })));

type DetailTab = "terminal" | "chat" | "history" | "files";

/** 외부에서 실행 중이라 거부되면 사용자에게 묻고, 동의하면 force 로 다시 시도한다. */
async function withExternalConfirm<T>(fn: (force: boolean) => Promise<T>): Promise<T | null> {
  try {
    return await fn(false);
  } catch (e) {
    const ext = externalRunning(e);
    if (!ext) throw e;
    const ok = await useStore.getState().ask({
      title: "다른 곳에서 실행 중인 세션",
      body: `이 대화는 ${clientLabel(ext.client)}(PID ${ext.pid})에서 실행 중입니다.\n같은 대화를 두 곳에서 동시에 이어가면 기록이 섞이거나, CLI 가 거부할 수 있습니다(Codex 는 다른 앱이 연 대화를 막습니다).\n\n그래도 여기서 열까요?`,
      danger: true,
      confirmLabel: "그래도 열기",
    });
    return ok ? fn(true) : null;
  }
}

export function AgentPanel() {
  const setNewOpen = useStore((s) => s.setNewSessionOpen);
  const newOpen = useStore((s) => s.newSessionOpen);
  return (
    <section className="panel" data-pane="2" tabIndex={-1}>
      <PanelHead title="에이전트">
        <button className="btn btn-small btn-primary" onClick={() => setNewOpen(true)} title="새 세션 (⌘N)">
          + 새 세션
        </button>
      </PanelHead>
      <Group orientation="vertical" className="agent-split">
        <Panel id="list" defaultSize="34" minSize="15">
          <SessionList />
        </Panel>
        <Separator className="sep sep-h" />
        <Panel id="detail" defaultSize="66" minSize="25">
          <SessionDetail />
        </Panel>
      </Group>
      {newOpen && <NewSessionDialog onClose={() => setNewOpen(false)} />}
    </section>
  );
}

// ───────────────────────── 세션 목록 ─────────────────────────

function SessionList() {
  const sessions = useStore((s) => s.sessions);
  const selected = useStore((s) => s.selectedSessionId);
  const select = useStore((s) => s.selectSession);
  const loading = useStore((s) => s.sessionsLoading);
  const refresh = useStore((s) => s.refreshSessions);
  const focus = useStore((s) => s.focus);
  const repos = useStore((s) => s.repos);
  const [q, setQ] = useState("");
  const [agent, setAgent] = useState<"all" | Agent>("all");
  const [scope, setScope] = useState<"all" | "repo">("all");
  const [showArchived, setShowArchived] = useState(false);
  const liveRuns = useStore((s) => s.liveRuns);
  const chats = useStore((s) => s.chats);
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const focusRepoId = repos.find((r) => r.worktrees.some((w) => w.path === focus?.worktreePath))?.id;
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sessions.filter((s) => {
      if (agent !== "all" && s.agent !== agent) return false;
      if (!showArchived && s.archived) return false;
      if (scope === "repo" && focusRepoId && s.repoId !== focusRepoId) return false;
      if (!needle) return true;
      return [s.title, s.firstPrompt, s.cwd, s.repoName, s.startBranch, s.currentBranch, s.externalId]
        .filter(Boolean)
        .some((x) => x!.toLowerCase().includes(needle));
    });
  }, [sessions, q, agent, scope, showArchived, focusRepoId]);
  // 상대 시각("3분 전")은 30초마다만 다시 계산한다.
  const now = Math.floor(Date.now() / 30_000) * 30_000;

  return (
    <div className="session-list">
      <div className="filters">
        <input className="search" placeholder="세션 검색 (제목·폴더·브랜치)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="세션 검색" />
        <select value={agent} onChange={(e) => setAgent(e.target.value as typeof agent)} aria-label="에이전트 종류">
          <option value="all">전체</option>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
        <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} aria-label="범위">
          <option value="all">모든 저장소</option>
          <option value="repo">보는 저장소만</option>
        </select>
        <label className="chk" title="Codex 에서 보관 처리한 세션">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          보관
        </label>
        <button className="btn btn-ghost btn-small" onClick={() => void refresh()} title="다시 읽기 (⌘R)" aria-label="세션 다시 읽기">
          {loading ? "…" : "↻"}
        </button>
      </div>
      <ul className="sessions" role="listbox" aria-label="에이전트 세션">
        {list.map((s) => (
          <SessionItem
            key={s.id}
            s={s}
            selected={s.id === selected}
            onSelect={select}
            now={now}
            ext={externalRunOf(s.id, liveRuns)}
            chat={chats.find((c) => c.sessionId === s.id || `chat:${c.id}` === s.id) ?? null}
          />
        ))}
        {!list.length && <li className="muted pad">조건에 맞는 세션이 없습니다</li>}
      </ul>
    </div>
  );
}

type ItemProps = { s: LinkedSession; selected: boolean; onSelect: (id: string) => void; now: number; ext: LiveRun | null; chat: ChatInfo | null };

/** 목록이 갱신돼도 바뀐 항목만 다시 그린다(에이전트 작업 중 매초 갱신되므로). */
const SessionItem = memo(SessionItemView, (a, b) =>
  a.selected === b.selected &&
  a.now === b.now &&
  a.onSelect === b.onSelect &&
  JSON.stringify(a.s) === JSON.stringify(b.s) &&
  JSON.stringify(a.ext) === JSON.stringify(b.ext) &&
  JSON.stringify(a.chat) === JSON.stringify(b.chat),
);

function SessionItemView({ s, selected, onSelect, now, ext, chat }: ItemProps) {
  const bs = branchState(s);
  const act = s.runningExecId || chat ? "running" : ext ? "external" : activity(s.updatedAt, now);
  const dotTitle =
    act === "running" ? (chat ? "앱의 채팅으로 열려 있음" : "앱의 터미널에서 실행 중") : act === "external" && ext ? `${clientLabel(ext.client)}에서 실행 중 (PID ${ext.pid}${ext.status ? ", " + ext.status : ""})` : act === "live" ? "방금 기록됨" : "";
  return (
    <li role="option" aria-selected={selected} className={`session${selected ? " on" : ""}`} onClick={() => onSelect(s.id)} data-session={s.id}>
      <div className="s-line">
        <AgentBadge agent={s.agent} small />
        <span className="s-title">{s.title}</span>
        {chat && <span className="tag" title="앱의 채팅으로 열려 있음">채팅</span>}
        {ext && !s.runningExecId && !chat && (
          <span className="tag tag-ext" title={dotTitle}>
            {clientLabel(ext.client)}
          </span>
        )}
        <span className={`dot dot-${act}`} title={dotTitle} />
        <span className="s-time">{relativeTime(s.updatedAt, now)}</span>
      </div>
      <div className="s-line s-sub">
        <span className="s-where" title={s.cwd ?? ""}>
          {s.repoName ? (
            <>
              {s.repoName}
              {s.worktreePath && baseName(s.worktreePath) !== s.repoName ? ` / ${baseName(s.worktreePath)}` : ""}
            </>
          ) : (
            <span className="muted">{s.cwd ? baseName(s.cwd) : "?"} (Git 아님)</span>
          )}
        </span>
        {s.worktreePath && (
          <span className={`branch-chip small${bs.changedSinceStart ? " warn" : ""}`} title={`시작: ${branchLabel(bs.start)} / 마지막 기록: ${branchLabel(bs.last)} / 현재: ${bs.unknownCurrent ? "알 수 없음" : branchLabel(bs.current)}`}>
            {bs.changedSinceStart ? `${branchLabel(bs.start)} → ${bs.currentDetached ? "detached" : branchLabel(bs.current)}` : branchLabel(bs.current ?? bs.start)}
          </span>
        )}
        {!s.cwdExists && <span className="tag tag-warn">폴더 없음</span>}
        {s.archived && <span className="tag">보관</span>}
      </div>
    </li>
  );
}

// ───────────────────────── 세션 상세 ─────────────────────────

function SessionDetail() {
  const session = useSelectedSession();
  const execs = useStore((s) => s.execs);
  const [tab, setTab] = useState<DetailTab>("history");
  const toast = useStore((s) => s.toast);
  const refreshExecs = useStore((s) => s.refreshExecs);
  const ask = useStore((s) => s.ask);

  // 이 세션의 가장 최근 실행 (끝난 것 포함)
  const exec = useMemo(() => {
    if (!session) return null;
    if (session.id.startsWith("exec:")) return execs.find((e) => `exec:${e.id}` === session.id) ?? null;
    const mine = execs.filter((e) => e.sessionId === session.id);
    return mine.length ? mine[mine.length - 1] : null;
  }, [session, execs]);

  const chats = useStore((s) => s.chats);
  const liveRuns = useStore((s) => s.liveRuns);
  const chat = session ? chats.find((c) => c.sessionId === session.id || `chat:${c.id}` === session.id) ?? null : null;
  const ext = session ? externalRunOf(session.id, liveRuns) : null;
  const [chatMode, setChatMode] = useState("default");

  // 세션을 바꾸면 채팅 → 실행 중 터미널 → 기록 순으로 먼저 보여 준다.
  const sid = session?.id;
  useEffect(() => {
    setTab(chat ? "chat" : exec && !exec.exited ? "terminal" : "history");
    setChatMode(session?.agent === "codex" ? "workspace-write" : "default");
  }, [sid]); // eslint-disable-line react-hooks/exhaustive-deps

  const resume = async () => {
    if (!session) return;
    try {
      const r = await withExternalConfirm((force) => api.execStart({ agent: session.agent, mode: "resume", sessionId: session.id, cols: 100, rows: 30, force }));
      if (!r) return;
      await refreshExecs();
      setTab("terminal");
    } catch (e) {
      toast("error", `재개 실패: ${errorText(e)}`);
    }
  };
  const openChat = async () => {
    if (!session) return;
    try {
      const r = await withExternalConfirm((force) => api.chatStart({ agent: session.agent, sessionId: session.id, mode: chatMode, force }));
      if (!r) return;
      await useStore.getState().refreshChats();
      setTab("chat");
    } catch (e) {
      toast("error", `채팅 열기 실패: ${errorText(e)}`);
    }
  };
  const closeChat = async () => {
    if (!chat) return;
    await api.chatClose(chat.id).catch(() => {});
    await useStore.getState().refreshChats();
  };
  const stop = async () => {
    if (!exec) return;
    const ok = await ask({ title: "에이전트 중지", body: "실행 중인 에이전트 프로세스를 종료합니다. 대화 기록은 남아 있어 나중에 재개할 수 있습니다.", confirmLabel: "중지", danger: true });
    if (ok) await api.execKill(exec.id).catch((e) => toast("error", errorText(e)));
  };

  return (
    <div className="session-detail">
      {session ? (
        <>
          <SessionHeader s={session} running={!!exec && !exec.exited} chatOpen={!!chat} onResume={resume} onStop={stop} onCloseChat={closeChat} />
          {ext && !(exec && !exec.exited) && !chat && (
            <div className="banner banner-ext" data-testid="external-banner">
              {clientLabel(ext.client)}에서 실행 중입니다 (PID {ext.pid}
              {ext.status ? `, ${ext.status}` : ""}). 여기서 동시에 열면 기록이 섞일 수 있습니다.
            </div>
          )}
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "terminal"} className={tab === "terminal" ? "on" : ""} onClick={() => setTab("terminal")}>
              터미널{exec && !exec.exited ? " ●" : ""}
            </button>
            <button role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")} data-tab="chat">
              채팅{chat ? " ●" : ""}
            </button>
            <button role="tab" aria-selected={tab === "history"} className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>
              기록
            </button>
            <button role="tab" aria-selected={tab === "files"} className={tab === "files" ? "on" : ""} onClick={() => setTab("files")}>
              작업한 파일
            </button>
          </div>
        </>
      ) : (
        <Empty title="세션을 고르세요">위 목록에서 Claude Code·Codex 세션을 고르면 Git 패널과 파일 탐색기가 그 세션의 워크트리를 보여 줍니다.</Empty>
      )}
      <div className="detail-body">
        <TerminalHost selectedExecId={session && tab === "terminal" ? exec?.id ?? null : null} />
        {session && tab === "terminal" && !exec && (
          <div className="term-placeholder">
            {session.id.startsWith("exec:") ? (
              "…"
            ) : (
              <>
                <p>이 세션은 앱에서 실행 중이 아닙니다.</p>
                <button className="btn btn-primary" onClick={resume} disabled={!session.cwdExists}>
                  {session.agent === "claude" ? "claude --resume" : "codex resume"} 으로 재개
                </button>
                {!session.cwdExists && <p className="muted">작업 폴더가 없어 재개할 수 없습니다: {session.cwd}</p>}
              </>
            )}
          </div>
        )}
        {session && tab === "terminal" && exec?.exited && (
          <div className="term-exit">
            프로세스가 종료되었습니다 (코드 {exec.exitCode ?? "?"}).{" "}
            {!session.id.startsWith("exec:") && (
              <button className="btn btn-small" onClick={resume}>
                다시 재개
              </button>
            )}
          </div>
        )}
        {session && tab === "chat" &&
          (chat ? (
            <ChatView chat={chat} />
          ) : (
            <div className="term-placeholder">
              <p>앱 안의 채팅 화면으로 이 대화를 이어갑니다. 도구 사용 허락을 여기서 버튼으로 답할 수 있습니다.</p>
              <label className="form-row" style={{ justifyContent: "center" }}>
                <span className="muted">{session.agent === "claude" ? "권한 모드" : "샌드박스"}</span>
                <select value={chatMode} onChange={(e) => setChatMode(e.target.value)} aria-label="채팅 권한">
                  {session.agent === "claude" ? (
                    <>
                      <option value="default">매번 묻기</option>
                      <option value="acceptEdits">파일 편집은 자동 허용</option>
                      <option value="plan">계획만 (수정 안 함)</option>
                    </>
                  ) : (
                    <>
                      <option value="workspace-write">작업 폴더 쓰기 허용</option>
                      <option value="read-only">읽기 전용</option>
                    </>
                  )}
                </select>
              </label>
              <button className="btn btn-primary" onClick={openChat} disabled={!session.cwdExists || !!(exec && !exec.exited) || session.id.startsWith("exec:")} data-action="open-chat">
                채팅으로 이어가기
              </button>
              {exec && !exec.exited && <p className="muted small">터미널에서 실행 중이라 채팅으로 열 수 없습니다. 먼저 중지하세요.</p>}
            </div>
          ))}
        {session && tab === "history" && <HistoryView s={session} />}
        {session && tab === "files" && <TouchedFilesView s={session} />}
      </div>
    </div>
  );
}

function SessionHeader({
  s,
  running,
  chatOpen,
  onResume,
  onStop,
  onCloseChat,
}: {
  s: LinkedSession;
  running: boolean;
  chatOpen: boolean;
  onResume: () => void;
  onStop: () => void;
  onCloseChat: () => void;
}) {
  const bs = branchState(s);
  return (
    <div className="session-head">
      <div className="sh-line">
        <AgentBadge agent={s.agent} />
        <span className="sh-title" title={s.title}>
          {s.title}
        </span>
        <span className="spacer" />
        {chatOpen ? (
          <button className="btn btn-small" onClick={onCloseChat} title="채팅 프로세스를 닫습니다. 대화는 남아 나중에 이어갈 수 있습니다.">
            채팅 닫기
          </button>
        ) : running ? (
          <button className="btn btn-small btn-danger" onClick={onStop}>
            중지
          </button>
        ) : (
          !s.id.startsWith("exec:") && (
            <button className="btn btn-small btn-primary" onClick={onResume} disabled={!s.cwdExists} data-testid="resume">
              재개
            </button>
          )
        )}
      </div>
      <div className="sh-grid">
        <span className="muted">저장소</span>
        <span>{s.repoName ?? <span className="muted">Git 저장소 아님</span>}</span>
        <span className="muted">워크트리</span>
        <span className="path-text" title={s.worktreePath ?? s.cwd ?? ""}>
          {s.worktreePath ?? s.cwd}
          {!s.cwdExists && <span className="tag tag-warn">없음</span>}
        </span>
        <span className="muted">브랜치</span>
        <span data-testid="session-branches">
          <span title="세션 시작 때 기록">시작 {branchLabel(bs.start)}</span>
          {bs.last && bs.last !== bs.start && <span title="마지막 기록"> · 마지막 {branchLabel(bs.last)}</span>}
          {" · "}
          <b className={bs.changedSinceStart || bs.changedSinceLast ? "warn-text" : ""} title="워크트리의 지금 브랜치 (Git)">
            지금 {bs.unknownCurrent ? "알 수 없음" : bs.currentDetached ? "detached HEAD" : branchLabel(bs.current)}
          </b>
        </span>
        <span className="muted">세션 id</span>
        <code className="sha" title={s.sourcePath}>
          {s.externalId || "(기록 대기 중)"}
        </code>
      </div>
    </div>
  );
}

function TerminalHost({ selectedExecId }: { selectedExecId: string | null }) {
  const execs = useStore((s) => s.execs);
  // 실행 중인 것마다 터미널을 유지하고 선택된 것만 보이게 한다(전환해도 프로세스·화면 유지).
  // 끝난 실행은 보고 있을 때만 그린다(다시 붙으면 백엔드 버퍼에서 재생). 메모리·WebGL 컨텍스트 절약.
  const shown = execs.filter((e) => !e.exited || e.id === selectedExecId);
  return (
    <div className="term-stack" style={{ display: selectedExecId ? "block" : "none" }}>
      {shown.length > 0 && (
        <Suspense fallback={<div className="loading">터미널 준비 중…</div>}>
          {shown.map((e) => (
            <TerminalView key={e.id} execId={e.id} visible={e.id === selectedExecId} />
          ))}
        </Suspense>
      )}
    </div>
  );
}

/** 값이 자주 바뀌어도 최소 ms 간격으로만 바뀐 값을 돌려준다(마지막 값은 반드시 반영). */
function useThrottled<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = Math.max(0, last.current + ms - Date.now());
    const t = window.setTimeout(() => {
      last.current = Date.now();
      setV(value);
    }, wait);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

function HistoryView({ s }: { s: LinkedSession }) {
  const [t, setT] = useState<Transcript | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);
  const pending = s.id.startsWith("exec:") || !s.sourcePath;
  // 에이전트가 일하는 동안 기록이 1초마다 바뀐다. 큰 기록을 매번 다시 읽지 않게 최소 3초 간격을 둔다.
  const updatedAt = useThrottled(s.updatedAt, 3000);
  useEffect(() => {
    if (pending) return;
    let alive = true;
    api.transcript(s.id).then(
      (x) => alive && (setT(x), setErr(null)),
      (e) => alive && setErr(errorText(e)),
    );
    return () => {
      alive = false;
    };
  }, [s.id, updatedAt, pending]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [t]);
  if (pending) return <Empty title="아직 기록이 없습니다">에이전트가 첫 응답을 기록하면 여기에 나타납니다.</Empty>;
  if (err) return <div className="banner banner-error">{err}</div>;
  if (!t) return <div className="loading">기록을 읽는 중…</div>;
  return (
    <div className="history">
      <div className="history-bar">
        <span className="muted">
          {t.total > t.items.length ? `최근 ${t.items.length}개 / 전체 ${t.total}개` : `${t.total}개`}
        </span>
        <label className="chk">
          <input type="checkbox" checked={showTools} onChange={(e) => setShowTools(e.target.checked)} /> 도구 실행 보기
        </label>
      </div>
      {t.items
        .filter((i) => showTools || i.kind !== "tool")
        .map((i, n) => (
          <div key={n} className={`msg msg-${i.kind}${i.isError ? " msg-error" : ""}`}>
            {i.kind === "tool" ? (
              <>
                <span className="tool-name">{i.tool}</span> <span className="tool-text">{i.text}</span>
              </>
            ) : (
              <div className="msg-text">{i.text}</div>
            )}
          </div>
        ))}
      <div ref={bottom} />
    </div>
  );
}

function TouchedFilesView({ s }: { s: LinkedSession }) {
  const [t, setT] = useState<Transcript | null>(null);
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const statusTick = useStore((st) => st.statusTick);
  const openViewer = useStore((st) => st.openViewer);
  const focus = useStore((st) => st.focus);
  const pending = s.id.startsWith("exec:") || !s.sourcePath;
  const updatedAt = useThrottled(s.updatedAt, 3000);
  useEffect(() => {
    let alive = true;
    if (!pending) api.transcript(s.id).then((x) => alive && setT(x), () => alive && setT(null));
    return () => {
      alive = false;
    };
  }, [s.id, updatedAt, pending]);
  useEffect(() => {
    let alive = true;
    if (s.worktreePath && s.cwdExists) api.status(s.worktreePath).then((x) => alive && setStatus(x), () => alive && setStatus(null));
    return () => {
      alive = false;
    };
  }, [s.worktreePath, s.cwdExists, statusTick]);
  const now = Date.now();
  if (pending) return <Empty title="아직 기록이 없습니다" />;
  if (!t) return <div className="loading">…</div>;
  if (!t.touchedFiles.length) return <Empty title="에이전트가 파일을 수정한 기록이 없습니다">Edit/Write(Claude), apply_patch(Codex) 도구 기록을 기준으로 합니다.</Empty>;
  // 기록의 경로는 /tmp/… 처럼 심볼릭 링크 형태일 수 있어 실제 경로와 별칭을 모두 본다.
  const roots = [s.worktreePath, s.worktreeAlias, s.worktreePath ? null : s.cwd];
  const kinds = new Map((status?.entries ?? []).map((e) => [e.path, e.kind]));
  const viewing = focus?.worktreePath === s.worktreePath;
  return (
    <ul className="file-list touched">
      {t.touchedFiles.map((f) => {
        const rel = relativeTo(roots, f.path);
        const now_kind = rel !== null ? kinds.get(rel) : undefined;
        return (
          <li
            key={f.path}
            className={rel === null ? "outside" : ""}
            onClick={() => rel !== null && viewing && openViewer({ kind: "file", rel, mode: now_kind ? "diff" : "preview" })}
            title={rel === null ? "워크트리 밖의 파일" : viewing ? "오른쪽에서 보기" : "이 세션 워크트리를 볼 때 열 수 있습니다"}
          >
            <span className={`kind kind-${now_kind ?? "clean"}`} title={now_kind ? `지금: ${kindLabel(now_kind)}` : "지금은 커밋됨/변경 없음"}>
              {kindLetter(now_kind) || "·"}
            </span>
            <span className="path">{rel ?? f.path}</span>
            <span className="muted small">
              {kindLabel(f.op)} {f.count > 1 ? `×${f.count}` : ""} {f.lastAt ? relativeTime(f.lastAt, now) : ""}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ───────────────────────── 새 세션 ─────────────────────────

function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const repos = useStore((s) => s.repos);
  const focus = useStore((s) => s.focus);
  const info = useStore((s) => s.info);
  const toast = useStore((s) => s.toast);
  const [agent, setAgent] = useState<Agent>("claude");
  const [cwd, setCwd] = useState(focus?.worktreePath ?? "");
  const [busy, setBusy] = useState(false);
  const [how, setHow] = useState<"terminal" | "chat">("terminal");
  const [mode, setMode] = useState("default");
  useEffect(() => setMode(agent === "codex" ? "workspace-write" : "default"), [agent]);
  const options = repos.flatMap((r) => r.worktrees.filter((w) => w.exists && !w.bare).map((w) => ({ repo: r.name, w })));

  const start = async () => {
    setBusy(true);
    try {
      const st = useStore.getState();
      if (how === "chat") {
        const c = await api.chatStart({ agent, cwd, mode });
        await st.refreshChats();
        st.selectSession(c.sessionId ?? `chat:${c.id}`);
      } else {
        const e = await api.execStart({ agent, mode: "new", cwd, cols: 100, rows: 30 });
        await st.refreshExecs();
        // 목록에 임시 항목으로 들어가 있으므로 고르면 그 워크트리로 포커스가 옮겨진다.
        st.selectSession(e.sessionId ?? `exec:${e.id}`);
      }
      onClose();
    } catch (err) {
      toast("error", `시작 실패: ${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="새 에이전트 세션" onMouseDown={(e) => e.stopPropagation()}>
        <h3>새 에이전트 세션</h3>
        <div className="form-row">
          <label>
            <input type="radio" checked={agent === "claude"} onChange={() => setAgent("claude")} /> Claude Code {!info?.claude && <span className="warn-text">(설치 안 됨)</span>}
          </label>
          <label>
            <input type="radio" checked={agent === "codex"} onChange={() => setAgent("codex")} /> Codex {!info?.codex && <span className="warn-text">(설치 안 됨)</span>}
          </label>
        </div>
        <div className="form-row col">
          <span className="muted">작업할 워크트리 (체크아웃하지 않고 그 폴더에서 실행합니다)</span>
          <select value={cwd} onChange={(e) => setCwd(e.target.value)} aria-label="워크트리">
            {cwd && !options.some((o) => o.w.path === cwd) && <option value={cwd}>{cwd}</option>}
            {options.map((o) => (
              <option key={o.w.path} value={o.w.path}>
                {o.repo} / {baseName(o.w.path)} — {o.w.detached ? "detached" : o.w.branch}
              </option>
            ))}
          </select>
          <button
            className="btn btn-small btn-ghost"
            onClick={async () => {
              const d = await open({ directory: true, multiple: false, title: "작업 폴더 선택" });
              if (typeof d === "string") setCwd(d);
            }}
          >
            다른 폴더…
          </button>
        </div>
        <div className="form-row">
          <label>
            <input type="radio" checked={how === "terminal"} onChange={() => setHow("terminal")} /> 터미널 (원본 CLI 화면)
          </label>
          <label>
            <input type="radio" checked={how === "chat"} onChange={() => setHow("chat")} /> 채팅 (앱 화면)
          </label>
        </div>
        {how === "chat" && (
          <div className="form-row col">
            <span className="muted">{agent === "claude" ? "권한 모드" : "샌드박스"}</span>
            <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="채팅 권한">
              {agent === "claude" ? (
                <>
                  <option value="default">매번 묻기 (도구마다 허용 버튼)</option>
                  <option value="acceptEdits">파일 편집은 자동 허용</option>
                  <option value="plan">계획만 (수정 안 함)</option>
                </>
              ) : (
                <>
                  <option value="workspace-write">작업 폴더 쓰기 허용</option>
                  <option value="read-only">읽기 전용</option>
                </>
              )}
            </select>
          </div>
        )}
        <p className="muted small">기존 CLI 로그인·구독을 그대로 씁니다. 앱은 대화 내용을 외부로 보내지 않습니다.</p>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            취소
          </button>
          <button className="btn btn-primary" disabled={!cwd || busy} onClick={start}>
            {busy ? "시작 중…" : "시작"}
          </button>
        </div>
      </div>
    </div>
  );
}
