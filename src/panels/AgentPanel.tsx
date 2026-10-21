import { open } from "@tauri-apps/plugin-dialog";
import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { api, errorText, externalRunning, type Agent, type ChatInfo, type LinkedSession, type LiveRun, type Transcript, type WorktreeStatus } from "../api";
import { ChevronDown, FolderGit2, GitBranch, Info, Play, Plus, RefreshCw, Square, X } from "lucide-react";
import { AgentBadge, ContextMenu, Empty } from "../components/Overlays";
import { baseName, branchLabel, branchState, clientLabel, externalRunOf, kindLabel, kindLetter, relativeTime, relativeTo } from "../logic";
import { useSelectedSession, useStore } from "../store";
import { PanelHead } from "./GitPanel";
import { ChatView } from "./ChatView";
// 터미널(xterm + WebGL, 약 460KB)은 실제로 띄울 때만 불러온다.
const TerminalView = lazy(() => import("./TerminalView").then((m) => ({ default: m.TerminalView })));

type DetailTab = "talk" | "history" | "files";

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
        <button className="btn btn-small btn-primary" onClick={() => setNewOpen(true)} title="새 에이전트 대화 시작 (⌘N)">
          <Plus size={13} aria-hidden /> 새 세션
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
  const [q, setQ] = useState("");
  const [agent, setAgent] = useState<"all" | Agent>("all");
  const [showArchived, setShowArchived] = useState(false);
  const liveRuns = useStore((s) => s.liveRuns);
  const chats = useStore((s) => s.chats);
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const folder = focus?.worktreePath ?? null;
  // 지금 보는 폴더(워크트리)에서 작업한 세션만 보여 준다.
  const inFolder = useMemo(() => sessions.filter((s) => folder !== null && s.worktreePath === folder), [sessions, folder]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return inFolder.filter((s) => {
      if (agent !== "all" && s.agent !== agent) return false;
      if (!showArchived && s.archived) return false;
      if (!needle) return true;
      return [s.title, s.firstPrompt, s.cwd, s.repoName, s.startBranch, s.currentBranch, s.externalId]
        .filter(Boolean)
        .some((x) => x!.toLowerCase().includes(needle));
    });
  }, [inFolder, q, agent, showArchived]);
  const titleCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of list) m.set(s.title, (m.get(s.title) ?? 0) + 1);
    return m;
  }, [list]);
  // 상대 시각("3분 전")은 30초마다만 다시 계산한다.
  const now = Math.floor(Date.now() / 30_000) * 30_000;

  return (
    <div className="session-list">
      <div className="filters">
        <input className="search" placeholder={folder ? `${baseName(folder)} 의 세션 검색` : "세션 검색"} value={q} onChange={(e) => setQ(e.target.value)} aria-label="세션 검색" />
        <select value={agent} onChange={(e) => setAgent(e.target.value as typeof agent)} aria-label="에이전트 종류">
          <option value="all">Claude·Codex</option>
          <option value="claude">Claude 만</option>
          <option value="codex">Codex 만</option>
        </select>
        <label className="chk" title="Codex 에서 보관 처리한 세션도 보여 줍니다">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          보관된 세션
        </label>
        <button className="icon-btn ghost" onClick={() => void refresh()} title="세션 목록 새로 읽기 (⌘R)" aria-label="세션 목록 새로 읽기">
          <RefreshCw size={13} aria-hidden className={loading ? "spin" : ""} />
        </button>
      </div>
      <ul className="sessions" role="listbox" aria-label="에이전트 세션">
        {list.map((s) => (
          <SessionItem
            key={s.id}
            dupHint={(titleCount.get(s.title) ?? 0) > 1 ? (s.externalId || s.id).replace(/^.*:/, "").slice(-6) : null}
            s={s}
            selected={s.id === selected}
            onSelect={select}
            now={now}
            ext={externalRunOf(s.id, liveRuns)}
            chat={chats.find((c) => c.sessionId === s.id || `chat:${c.id}` === s.id) ?? null}
          />
        ))}
        {!list.length && (
          <li className="muted pad">
            {!folder
              ? "위에서 폴더(저장소·워크트리)를 고르세요."
              : inFolder.length
                ? "검색 조건에 맞는 세션이 없습니다."
                : `${baseName(folder)} 에서 작업한 세션이 아직 없습니다. '+ 새 세션' 으로 시작하세요.`}
          </li>
        )}
      </ul>
    </div>
  );
}

type ItemProps = {
  s: LinkedSession;
  selected: boolean;
  onSelect: (id: string) => void;
  now: number;
  ext: LiveRun | null;
  chat: ChatInfo | null;
  /** 같은 제목이 여러 개일 때 구분용 짧은 id */
  dupHint: string | null;
};

/** 목록이 갱신돼도 바뀐 항목만 다시 그린다(에이전트 작업 중 매초 갱신되므로). */
const SessionItem = memo(SessionItemView, (a, b) =>
  a.selected === b.selected &&
  a.now === b.now &&
  a.onSelect === b.onSelect &&
  a.dupHint === b.dupHint &&
  JSON.stringify(a.s) === JSON.stringify(b.s) &&
  JSON.stringify(a.ext) === JSON.stringify(b.ext) &&
  JSON.stringify(a.chat) === JSON.stringify(b.chat),
);

/** 세션 상태를 글자로(색 점만으로는 뜻을 알 수 없다) */
export function sessionStatus(s: LinkedSession, ext: LiveRun | null, chat: ChatInfo | null): { label: string; cls: string; title: string } | null {
  if (chat) return { label: chat.busy ? "답하는 중" : "채팅 열림", cls: "st-chat", title: "이 앱의 채팅 화면에서 열려 있습니다" };
  if (s.runningExecId) return { label: "터미널 실행 중", cls: "st-run", title: "이 앱의 터미널에서 실행 중입니다" };
  if (ext) return { label: `${clientLabel(ext.client)}에서 실행 중`, cls: "st-ext", title: `앱 밖에서 실행 중 (PID ${ext.pid}${ext.status ? ", " + ext.status : ""}). 여기서 동시에 열면 기록이 섞일 수 있습니다.` };
  return null;
}

function SessionItemView({ s, selected, onSelect, now, ext, chat, dupHint }: ItemProps) {
  const bs = branchState(s);
  const status = sessionStatus(s, ext, chat);
  const snippet = s.firstPrompt && !s.title.startsWith(s.firstPrompt.slice(0, 20)) ? s.firstPrompt : null;
  return (
    <li role="option" aria-selected={selected} className={`session${selected ? " on" : ""}`} onClick={() => onSelect(s.id)} data-session={s.id}>
      <div className="s-line">
        <AgentBadge agent={s.agent} small />
        <span className="s-title">{s.title}</span>
        {dupHint && <span className="s-dup" title="같은 제목의 세션을 구분하는 id">#{dupHint}</span>}
        <span className="s-time">{relativeTime(s.updatedAt, now)}</span>
      </div>
      <div className="s-line s-sub">
        {status && (
          <span className={`s-status ${status.cls}`} title={status.title}>
            {status.label}
          </span>
        )}
        {s.worktreePath && (bs.changedSinceLast || (bs.current ?? bs.last)) && (
          <span
            className={`branch-chip small${bs.changedSinceLast ? " warn" : ""}`}
            title={`세션 시작: ${branchLabel(bs.start)} · 마지막 작업: ${branchLabel(bs.last)} · 지금 폴더: ${bs.unknownCurrent ? "알 수 없음" : branchLabel(bs.current)}`}
          >
            <GitBranch size={11} aria-hidden />{" "}
            {bs.changedSinceLast ? `${branchLabel(bs.last)} → ${bs.currentDetached ? "브랜치 없음" : branchLabel(bs.current)}` : branchLabel(bs.current ?? bs.last)}
          </span>
        )}
        {snippet && <span className="s-snippet">{snippet}</span>}
        {!s.cwdExists && <span className="tag tag-warn">폴더 없음</span>}
        {s.archived && <span className="tag">보관됨</span>}
      </div>
    </li>
  );
}

// ───────────────────────── 세션 상세 ─────────────────────────

type ContinueHow = "chat" | "terminal";
const PREF_KEY = "aiterm.continueHow";
const modeKey = (agent: Agent) => `aiterm.chatMode.${agent}`;
const defaultMode = (agent: Agent) => (agent === "codex" ? "workspace-write" : "default");

function SessionDetail() {
  const session = useSelectedSession();
  const execs = useStore((s) => s.execs);
  const [tab, setTab] = useState<DetailTab>("talk");
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
  const running = !!exec && !exec.exited;
  const live = !!chat || !!exec; // 대화 탭에 실시간 화면(채팅·터미널)이 있음

  const sid = session?.id;
  useEffect(() => {
    setTab("talk");
  }, [sid]);

  const resume = async () => {
    if (!session) return;
    try {
      const r = await withExternalConfirm((force) => api.execStart({ agent: session.agent, mode: "resume", sessionId: session.id, cols: 100, rows: 30, force }));
      if (!r) return;
      localStorage.setItem(PREF_KEY, "terminal");
      await refreshExecs();
      setTab("talk");
    } catch (e) {
      toast("error", `이어가기 실패: ${errorText(e)}`);
    }
  };
  const openChat = async () => {
    if (!session) return;
    const mode = localStorage.getItem(modeKey(session.agent)) ?? defaultMode(session.agent);
    try {
      const r = await withExternalConfirm((force) => api.chatStart({ agent: session.agent, sessionId: session.id, mode, force }));
      if (!r) return;
      localStorage.setItem(PREF_KEY, "chat");
      await useStore.getState().refreshChats();
      setTab("talk");
    } catch (e) {
      toast("error", `이어가기 실패: ${errorText(e)}`);
    }
  };
  const closeChat = async () => {
    if (!chat) return;
    await api.chatClose(chat.id).catch(() => {});
    await useStore.getState().refreshChats();
  };
  const stop = async () => {
    if (!exec) return;
    const ok = await ask({ title: "에이전트 멈추기", body: "실행 중인 에이전트 프로세스를 끝냅니다. 대화 기록은 남아 있어 나중에 이어갈 수 있습니다.", confirmLabel: "멈추기", danger: true });
    if (ok) await api.execKill(exec.id).catch((e) => toast("error", errorText(e)));
  };

  if (!session) {
    return (
      <div className="session-detail">
        <Empty title="세션을 고르세요">위 목록에서 대화를 고르면 왼쪽 Git 과 오른쪽 파일이 그 대화가 작업한 폴더를 보여 줍니다.</Empty>
      </div>
    );
  }
  const pending = session.id.startsWith("exec:") || session.id.startsWith("chat:");
  return (
    <div className="session-detail">
      <SessionHeader
        s={session}
        running={running}
        chatOpen={!!chat}
        ext={ext}
        chat={chat}
        canContinue={session.cwdExists && !pending}
        onChat={openChat}
        onTerminal={resume}
        onStop={stop}
        onCloseChat={closeChat}
      />
      {ext && !running && !chat && (
        <div className="banner banner-ext" data-testid="external-banner">
          {clientLabel(ext.client)}에서 열려 있는 대화입니다 (PID {ext.pid}). 여기서 동시에 이어가면 기록이 섞일 수 있어요.
        </div>
      )}
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "talk"} className={tab === "talk" ? "on" : ""} onClick={() => setTab("talk")} data-tab="talk">
          대화
        </button>
        {live && (
          <button role="tab" aria-selected={tab === "history"} className={tab === "history" ? "on" : ""} onClick={() => setTab("history")} data-tab="history">
            이전 기록
          </button>
        )}
        <button role="tab" aria-selected={tab === "files"} className={tab === "files" ? "on" : ""} onClick={() => setTab("files")} data-tab="files">
          작업한 파일
        </button>
      </div>
      <div className="detail-body">
        <TerminalHost selectedExecId={tab === "talk" && !chat ? exec?.id ?? null : null} />
        {tab === "talk" && chat && <ChatView chat={chat} />}
        {tab === "talk" && !chat && exec?.exited && (
          <div className="term-exit">
            에이전트가 끝났습니다 (코드 {exec.exitCode ?? "?"}).{" "}
            {!pending && (
              <button className="btn btn-small" onClick={resume}>
                터미널로 다시 이어가기
              </button>
            )}
          </div>
        )}
        {tab === "talk" && !live && <HistoryView s={session} />}
        {tab === "history" && <HistoryView s={session} />}
        {tab === "files" && <TouchedFilesView s={session} />}
      </div>
    </div>
  );
}

function SessionHeader({
  s,
  running,
  chatOpen,
  ext,
  chat,
  canContinue,
  onChat,
  onTerminal,
  onStop,
  onCloseChat,
}: {
  s: LinkedSession;
  running: boolean;
  chatOpen: boolean;
  ext: LiveRun | null;
  chat: ChatInfo | null;
  canContinue: boolean;
  onChat: () => void;
  onTerminal: () => void;
  onStop: () => void;
  onCloseChat: () => void;
}) {
  const bs = branchState(s);
  const [info, setInfo] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [, force] = useState(0);
  const status = sessionStatus(s, ext, chat);
  const how = (localStorage.getItem(PREF_KEY) as ContinueHow | null) ?? "chat";
  const mode = localStorage.getItem(modeKey(s.agent)) ?? defaultMode(s.agent);
  const modes =
    s.agent === "claude"
      ? [
          ["default", "도구마다 허락 묻기"],
          ["acceptEdits", "파일 편집은 자동 허락"],
          ["plan", "계획만 세우기 (수정 안 함)"],
        ]
      : [
          ["workspace-write", "이 폴더 안에서 쓰기 허락"],
          ["read-only", "읽기만 허락"],
        ];
  const copy = (t: string) => void navigator.clipboard.writeText(t);
  const branchText = bs.unknownCurrent ? "브랜치 알 수 없음" : bs.currentDetached ? "브랜치 없음(커밋)" : branchLabel(bs.current);
  return (
    <div className="session-head">
      <div className="sh-line">
        <AgentBadge agent={s.agent} />
        <span className="sh-title" title={s.title}>
          {s.title}
        </span>
        {status && (
          <span className={`s-status ${status.cls}`} title={status.title}>
            {status.label}
          </span>
        )}
        <span className="spacer" />
        {chatOpen ? (
          <button className="btn btn-small" onClick={onCloseChat} title="채팅을 닫습니다. 대화는 남아 나중에 이어갈 수 있어요.">
            <X size={12} aria-hidden /> 채팅 닫기
          </button>
        ) : running ? (
          <button className="btn btn-small btn-danger" onClick={onStop}>
            <Square size={12} aria-hidden /> 멈추기
          </button>
        ) : (
          canContinue && (
            <div className="split-btn">
              <button className="btn btn-small btn-primary" onClick={how === "terminal" ? onTerminal : onChat} data-testid="continue" title={how === "terminal" ? "원본 CLI 터미널로 이어가기" : "앱의 채팅 화면으로 이어가기"}>
                <Play size={12} aria-hidden /> 이어가기
              </button>
              <button
                className="btn btn-small btn-primary split-caret"
                aria-label="이어가기 방법 고르기"
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setMenu({ x: r.right - 260, y: r.bottom + 4 });
                }}
              >
                <ChevronDown size={14} aria-hidden />
              </button>
            </div>
          )
        )}
      </div>
      <div className="sh-meta">
        <span title={s.worktreePath ?? s.cwd ?? ""}>
          <FolderGit2 size={12} aria-hidden /> {s.worktreePath ? baseName(s.worktreePath) : s.cwd ? `${baseName(s.cwd)} (Git 아님)` : "?"}
        </span>
        {s.worktreePath && (
          <span data-testid="session-branches" title={`세션 시작: ${branchLabel(bs.start)} · 마지막 작업: ${branchLabel(bs.last)} · 지금 폴더: ${branchText}`} className={bs.changedSinceLast ? "warn-text" : ""}>
            <GitBranch size={12} aria-hidden /> {bs.changedSinceLast ? `${branchLabel(bs.last)}에서 작업 → 지금 ${branchText}` : branchText}
          </span>
        )}
        <span className="muted">{relativeTime(s.updatedAt, Date.now())}</span>
        {!s.cwdExists && <span className="tag tag-warn">폴더 없음</span>}
        <button className="icon-btn ghost" onClick={() => setInfo(!info)} aria-label="자세히" title="경로·세션 id 자세히" aria-expanded={info}>
          <Info size={13} aria-hidden />
        </button>
      </div>
      {info && (
        <div className="sh-grid">
          <span className="muted">저장소</span>
          <span>{s.repoName ?? <span className="muted">Git 저장소 아님</span>}</span>
          <span className="muted">폴더</span>
          <span className="path-text copyable" title="눌러서 복사" onClick={() => copy(s.worktreePath ?? s.cwd ?? "")}>
            {s.worktreePath ?? s.cwd}
          </span>
          <span className="muted">브랜치</span>
          <span>
            시작 {branchLabel(bs.start)} · 마지막 {branchLabel(bs.last)} · 지금 {branchText}
          </span>
          <span className="muted">세션 id</span>
          <code className="sha copyable" title="눌러서 복사" onClick={() => copy(s.externalId)}>
            {s.externalId || "(기록 대기 중)"}
          </code>
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "앱 채팅 화면으로 이어가기", hint: "도구 사용을 버튼으로 허락", onClick: onChat, testId: "open-chat" },
            { label: "원본 CLI 터미널로 이어가기", hint: s.agent === "claude" ? "claude --resume" : "codex resume", onClick: onTerminal, testId: "resume" },
            { header: true, label: "채팅에서 쓸 허락 범위" },
            ...modes.map(([v, label]) => ({
              label: `${mode === v ? "✓ " : " "}${label}`,
              onClick: () => {
                localStorage.setItem(modeKey(s.agent), v);
                force((n) => n + 1);
              },
            })),
          ]}
        />
      )}
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
  const [how, setHow] = useState<"terminal" | "chat">(((localStorage.getItem(PREF_KEY) as ContinueHow | null) ?? "chat") as "terminal" | "chat");
  const [mode, setMode] = useState(localStorage.getItem(modeKey("claude")) ?? "default");
  const [prompt, setPrompt] = useState("");
  useEffect(() => setMode(localStorage.getItem(modeKey(agent)) ?? defaultMode(agent)), [agent]);
  const options = repos.flatMap((r) => r.worktrees.filter((w) => w.exists && !w.bare).map((w) => ({ repo: r, w })));
  const focusRepo = repos.find((r) => r.worktrees.some((w) => w.path === cwd));

  const pickFolder = async (v: string) => {
    if (v === "__new_wt__") {
      const base = focusRepo?.path ?? repos[0]?.path;
      if (!base) return toast("error", "먼저 저장소를 추가하세요");
      await (await import("../gitActions")).newWorktree(base, { base: "HEAD" });
      const f = useStore.getState().focus?.worktreePath;
      if (f) setCwd(f);
      return;
    }
    if (v === "__other__") {
      const d = await open({ directory: true, multiple: false, title: "작업 폴더 선택" });
      if (typeof d === "string") setCwd(d);
      return;
    }
    setCwd(v);
  };

  const start = async () => {
    if (!cwd || busy) return;
    setBusy(true);
    try {
      const st = useStore.getState();
      localStorage.setItem(PREF_KEY, how);
      localStorage.setItem(modeKey(agent), mode);
      if (how === "chat") {
        const c = await api.chatStart({ agent, cwd, mode });
        await st.refreshChats();
        st.selectSession(c.sessionId ?? `chat:${c.id}`);
        if (prompt.trim()) await api.chatSend(c.id, prompt.trim());
      } else {
        const e = await api.execStart({ agent, mode: "new", cwd, cols: 100, rows: 30, prompt: prompt.trim() || undefined });
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

  const card = (on: boolean, onClick: () => void, title: string, sub: string, disabledNote?: string | null) => (
    <button type="button" className={`choice${on ? " on" : ""}`} onClick={onClick} aria-pressed={on}>
      <span className="choice-title">{title}</span>
      <span className="choice-sub">{disabledNote ?? sub}</span>
    </button>
  );
  const modes =
    agent === "claude"
      ? [
          ["default", "도구마다 허락 묻기"],
          ["acceptEdits", "파일 편집은 자동 허락"],
          ["plan", "계획만 세우기 (수정 안 함)"],
        ]
      : [
          ["workspace-write", "이 폴더 안에서 쓰기 허락"],
          ["read-only", "읽기만 허락"],
        ];

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label="새 에이전트 세션" onMouseDown={(e) => e.stopPropagation()}>
        <h3>새 에이전트 세션</h3>
        <div className="choice-row">
          {card(agent === "claude", () => setAgent("claude"), "Claude Code", "Anthropic", info && !info.claude ? "설치되지 않음" : null)}
          {card(agent === "codex", () => setAgent("codex"), "Codex", "OpenAI", info && !info.codex ? "설치되지 않음" : null)}
        </div>
        <label className="form-row col">
          <span className="muted">작업할 폴더 (지금 브랜치를 바꾸지 않고 그 폴더에서 바로 실행해요)</span>
          <select value={cwd} onChange={(e) => void pickFolder(e.target.value)} aria-label="작업 폴더">
            {cwd && !options.some((o) => o.w.path === cwd) && <option value={cwd}>{cwd}</option>}
            {options.map((o) => (
              <option key={o.w.path} value={o.w.path}>
                {baseName(o.w.path) === o.repo.name ? o.repo.name : `${o.repo.name} / ${baseName(o.w.path)}`} — {o.w.detached ? "브랜치 없음" : o.w.branch}
              </option>
            ))}
            <option value="__new_wt__">＋ 새 워크트리 만들어서 시작…</option>
            <option value="__other__">다른 폴더 고르기…</option>
          </select>
        </label>
        <div className="choice-row">
          {card(how === "chat", () => setHow("chat"), "앱 채팅 화면", "도구 사용을 버튼으로 허락")}
          {card(how === "terminal", () => setHow("terminal"), "원본 CLI 터미널", "CLI 화면 그대로")}
        </div>
        {how === "chat" && (
          <label className="form-row col">
            <span className="muted">허락 범위</span>
            <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="허락 범위">
              {modes.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="form-row col">
          <span className="muted">첫 지시 (선택)</span>
          <textarea
            className="text-input"
            rows={3}
            value={prompt}
            placeholder="예: 로그인 버튼이 눌리지 않는 버그를 고쳐 줘"
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) void start();
            }}
            data-testid="first-prompt"
          />
        </label>
        <p className="muted small">기존 CLI 로그인·구독을 그대로 써요. 이 앱은 대화 내용을 외부로 보내지 않아요.</p>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            취소
          </button>
          <button className="btn btn-primary" disabled={!cwd || busy} onClick={start} title="⌘⏎">
            {busy ? "시작하는 중…" : "시작"}
          </button>
        </div>
      </div>
    </div>
  );
}
