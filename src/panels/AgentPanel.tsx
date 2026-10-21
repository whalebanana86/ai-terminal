import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { api, errorText, type Agent, type LinkedSession, type Transcript, type WorktreeStatus } from "../api";
import { AgentBadge, Empty } from "../components/Overlays";
import { activity, baseName, branchLabel, branchState, kindLabel, kindLetter, relativeTime, relativeTo } from "../logic";
import { useSelectedSession, useStore } from "../store";
import { PanelHead } from "./GitPanel";
import { TerminalView } from "./TerminalView";

type DetailTab = "terminal" | "history" | "files";

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
  const now = Date.now();

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
          <SessionItem key={s.id} s={s} selected={s.id === selected} onSelect={() => select(s.id)} now={now} />
        ))}
        {!list.length && <li className="muted pad">조건에 맞는 세션이 없습니다</li>}
      </ul>
    </div>
  );
}

function SessionItem({ s, selected, onSelect, now }: { s: LinkedSession; selected: boolean; onSelect: () => void; now: number }) {
  const bs = branchState(s);
  const act = s.runningExecId ? "running" : activity(s.updatedAt, now);
  return (
    <li role="option" aria-selected={selected} className={`session${selected ? " on" : ""}`} onClick={onSelect} data-session={s.id}>
      <div className="s-line">
        <AgentBadge agent={s.agent} small />
        <span className="s-title">{s.title}</span>
        <span className={`dot dot-${act}`} title={act === "running" ? "앱에서 실행 중" : act === "live" ? "방금 기록됨 (외부에서 진행 중일 수 있음)" : ""} />
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

  // 세션을 바꾸면 실행 중이면 터미널, 아니면 기록을 먼저 보여 준다.
  const sid = session?.id;
  useEffect(() => {
    setTab(exec && !exec.exited ? "terminal" : "history");
  }, [sid]); // eslint-disable-line react-hooks/exhaustive-deps

  const resume = async () => {
    if (!session) return;
    try {
      await api.execStart({ agent: session.agent, mode: "resume", sessionId: session.id, cols: 100, rows: 30 });
      await refreshExecs();
      setTab("terminal");
    } catch (e) {
      toast("error", `재개 실패: ${errorText(e)}`);
    }
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
          <SessionHeader s={session} running={!!exec && !exec.exited} onResume={resume} onStop={stop} />
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "terminal"} className={tab === "terminal" ? "on" : ""} onClick={() => setTab("terminal")}>
              터미널{exec && !exec.exited ? " ●" : ""}
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
        {session && tab === "history" && <HistoryView s={session} />}
        {session && tab === "files" && <TouchedFilesView s={session} />}
      </div>
    </div>
  );
}

function SessionHeader({ s, running, onResume, onStop }: { s: LinkedSession; running: boolean; onResume: () => void; onStop: () => void }) {
  const bs = branchState(s);
  return (
    <div className="session-head">
      <div className="sh-line">
        <AgentBadge agent={s.agent} />
        <span className="sh-title" title={s.title}>
          {s.title}
        </span>
        <span className="spacer" />
        {running ? (
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
  // 실행마다 터미널을 하나씩 유지하고 선택된 것만 보이게 한다(전환해도 프로세스·화면 유지).
  return (
    <div className="term-stack" style={{ display: selectedExecId ? "block" : "none" }}>
      {execs.map((e) => (
        <TerminalView key={e.id} execId={e.id} visible={e.id === selectedExecId} />
      ))}
    </div>
  );
}

function HistoryView({ s }: { s: LinkedSession }) {
  const [t, setT] = useState<Transcript | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);
  const pending = s.id.startsWith("exec:") || !s.sourcePath;
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
  }, [s.id, s.updatedAt, pending]);
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
  const gitTick = useStore((st) => st.gitTick);
  const openViewer = useStore((st) => st.openViewer);
  const focus = useStore((st) => st.focus);
  const pending = s.id.startsWith("exec:") || !s.sourcePath;
  useEffect(() => {
    let alive = true;
    if (!pending) api.transcript(s.id).then((x) => alive && setT(x), () => alive && setT(null));
    return () => {
      alive = false;
    };
  }, [s.id, s.updatedAt, pending]);
  useEffect(() => {
    let alive = true;
    if (s.worktreePath && s.cwdExists) api.status(s.worktreePath).then((x) => alive && setStatus(x), () => alive && setStatus(null));
    return () => {
      alive = false;
    };
  }, [s.worktreePath, s.cwdExists, gitTick]);
  const now = Date.now();
  if (pending) return <Empty title="아직 기록이 없습니다" />;
  if (!t) return <div className="loading">…</div>;
  if (!t.touchedFiles.length) return <Empty title="에이전트가 파일을 수정한 기록이 없습니다">Edit/Write(Claude), apply_patch(Codex) 도구 기록을 기준으로 합니다.</Empty>;
  const root = s.worktreePath ?? s.cwd ?? "";
  const kinds = new Map((status?.entries ?? []).map((e) => [e.path, e.kind]));
  const viewing = focus?.worktreePath === s.worktreePath;
  return (
    <ul className="file-list touched">
      {t.touchedFiles.map((f) => {
        const rel = relativeTo(root, f.path);
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
  const options = repos.flatMap((r) => r.worktrees.filter((w) => w.exists && !w.bare).map((w) => ({ repo: r.name, w })));

  const start = async () => {
    setBusy(true);
    try {
      const e = await api.execStart({ agent, mode: "new", cwd, cols: 100, rows: 30 });
      const st = useStore.getState();
      await st.refreshExecs();
      // 목록에 임시 항목으로 들어가 있으므로 고르면 그 워크트리로 포커스가 옮겨진다.
      st.selectSession(e.sessionId ?? `exec:${e.id}`);
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
