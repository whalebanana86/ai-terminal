import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import type { ChangeBatch } from "./api";
import { api } from "./api";
import { ConfirmDialog, Toasts } from "./components/Overlays";
import { TopBar } from "./components/TopBar";
import { AgentPanel } from "./panels/AgentPanel";
import { FilePanel } from "./panels/FilePanel";
import { GitPanel } from "./panels/GitPanel";
import { useStore } from "./store";
import "./styles.css";

export default function App() {
  const boot = useStore((s) => s.boot);
  const restored = useStore((s) => s.restored);
  const focus = useStore((s) => s.focus);
  const execs = useStore((s) => s.execs);

  useEffect(() => {
    void boot();
  }, [boot]);

  // 백엔드 이벤트
  useEffect(() => {
    const st = useStore.getState;
    let sessionTimer: number | undefined;
    const unsubs = [
      listen<ChangeBatch>("fs-changed", (e) => st().onFsChanged(e.payload.worktree, e.payload.paths, e.payload.files, e.payload.git)),
      listen<string[]>("sessions-changed", () => {
        window.clearTimeout(sessionTimer);
        sessionTimer = window.setTimeout(() => void st().refreshSessions(), 400);
      }),
      listen<{ id: string; code: number | null }>("exec-exit", async (e) => {
        await st().refreshExecs();
        st().toast(e.payload.code === 0 ? "info" : "error", `에이전트 프로세스가 종료되었습니다 (코드 ${e.payload.code ?? "?"})`);
        void st().refreshSessions();
      }),
      listen("exec-linked", async () => {
        await st().refreshExecs();
        void st().refreshSessions();
      }),
    ];
    return () => {
      unsubs.forEach((p) => p.then((u) => u()));
    };
  }, []);

  // 감시 대상 = 포커스 워크트리 + 실행 중인 에이전트의 워크트리
  const watchKey = [focus?.worktreePath ?? "", ...execs.filter((e) => !e.exited).map((e) => e.worktreePath ?? e.cwd)].sort().join("\n");
  const watchNonce = useStore((s) => s.watchNonce);
  useEffect(() => {
    const list = [...new Set(watchKey.split("\n").filter(Boolean))];
    api.watchSet(list).catch((e) => console.warn("watch_set", e));
  }, [watchKey, watchNonce]);

  // 실행 중 세션이 있으면 주기적으로 세션 목록(마지막 기록 시각 등)을 갱신한다.
  const hasRunning = execs.some((e) => !e.exited);
  useEffect(() => {
    if (!hasRunning) return;
    const t = window.setInterval(() => void useStore.getState().refreshSessions(), 15_000);
    return () => window.clearInterval(t);
  }, [hasRunning]);

  useShortcuts();

  const layout = useDefaultLayout({ id: "main-3pane", storage: localStorage, panelIds: ["git", "agent", "files"] });

  return (
    <div className="app">
      <TopBar />
      {!restored ? (
        <div className="boot">세션과 저장소를 읽는 중…</div>
      ) : (
        <Group orientation="horizontal" className="panes" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
          <Panel id="git" defaultSize="33" minSize="18" className="pane">
            <GitPanel />
          </Panel>
          <Separator className="sep" />
          <Panel id="agent" defaultSize="34" minSize="22" className="pane">
            <AgentPanel />
          </Panel>
          <Separator className="sep" />
          <Panel id="files" defaultSize="33" minSize="16" className="pane">
            <FilePanel />
          </Panel>
        </Group>
      )}
      <Toasts />
      <ConfirmDialog />
    </div>
  );
}

function useShortcuts() {
  const lastKey = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      // 터미널 입력 중에도 앱 단축키가 먹도록 metaKey 조합만 쓴다.
      const st = useStore.getState();
      const list = st.sessions;
      const idx = list.findIndex((s) => s.id === st.selectedSessionId);
      if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        st.setNewSessionOpen(true);
      } else if (e.key === "r" && !e.shiftKey) {
        e.preventDefault();
        if (Date.now() - lastKey.current < 300) return;
        lastKey.current = Date.now();
        void st.refreshSessions();
        void st.refreshRepos();
        st.bumpGit();
      } else if (e.key === "]" || (e.key === "ArrowDown" && e.altKey)) {
        e.preventDefault();
        const next = list[Math.min(list.length - 1, idx + 1)];
        if (next) st.selectSession(next.id);
      } else if (e.key === "[" || (e.key === "ArrowUp" && e.altKey)) {
        e.preventDefault();
        const prev = list[Math.max(0, idx - 1)];
        if (prev) st.selectSession(prev.id);
      } else if (["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
        const el = document.querySelector<HTMLElement>(`[data-pane="${e.key}"]`);
        el?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
