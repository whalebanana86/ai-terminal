// 앱 전역 상태. "focus" 하나를 세 패널이 함께 구독한다.
import { create } from "zustand";
import { api, errorText, type AppInfo, type ExecInfo, type LinkedSession, type RepoSummary } from "./api";
import { mergeSessions } from "./logic";

/** 세 패널이 바라보는 워크트리. 조회 전용이며 절대 체크아웃을 일으키지 않는다. */
export interface Focus {
  worktreePath: string;
  /** 왜 이 워크트리를 보는지 */
  source: "session" | "manual";
}

export type Viewer =
  | { kind: "file"; rel: string; mode: "preview" | "diff" }
  | { kind: "commit-file"; sha: string; rel: string }
  | null;

export interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  text: string;
}

export interface ConfirmRequest {
  title: string;
  body: string;
  danger?: boolean;
  confirmLabel?: string;
  resolve: (ok: boolean) => void;
}

interface State {
  info: AppInfo | null;
  repos: RepoSummary[];
  rawSessions: LinkedSession[];
  sessions: LinkedSession[];
  execs: ExecInfo[];
  sessionsLoading: boolean;
  selectedSessionId: string | null;
  focus: Focus | null;
  viewer: Viewer;
  /** 포커스 워크트리의 파일/깃 변경 신호 (값이 바뀌면 다시 읽는다) */
  fsTick: number;
  gitTick: number;
  changedPaths: string[];
  /** 워크트리 → 최근 파일 변경 시각 (실행 중인 다른 세션 표시용) */
  worktreeActivity: Record<string, number>;
  toasts: Toast[];
  confirm: ConfirmRequest | null;
  newSessionOpen: boolean;
  restored: boolean;

  boot: () => Promise<void>;
  refreshRepos: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshExecs: () => Promise<void>;
  selectSession: (id: string | null) => void;
  setFocusWorktree: (path: string) => void;
  openViewer: (v: Viewer) => void;
  toast: (kind: Toast["kind"], text: string) => void;
  dismissToast: (id: number) => void;
  ask: (req: Omit<ConfirmRequest, "resolve">) => Promise<boolean>;
  setNewSessionOpen: (open: boolean) => void;
  onFsChanged: (worktree: string, paths: string[], files: boolean, git: boolean) => void;
  bumpGit: () => void;
}

let toastSeq = 1;

function persist(key: string, value: unknown) {
  api.kvSet(key, JSON.stringify(value)).catch(() => {});
}

export const useStore = create<State>((set, get) => ({
  info: null,
  repos: [],
  rawSessions: [],
  sessions: [],
  execs: [],
  sessionsLoading: false,
  selectedSessionId: null,
  focus: null,
  viewer: null,
  fsTick: 0,
  gitTick: 0,
  changedPaths: [],
  worktreeActivity: {},
  toasts: [],
  confirm: null,
  newSessionOpen: false,
  restored: false,

  boot: async () => {
    const [info, focusRaw, selRaw] = await Promise.all([
      api.appInfo().catch(() => null),
      api.kvGet("focus").catch(() => null),
      api.kvGet("selectedSession").catch(() => null),
    ]);
    set({ info });
    try {
      if (focusRaw) set({ focus: JSON.parse(focusRaw) });
      if (selRaw) set({ selectedSessionId: JSON.parse(selRaw) });
    } catch {
      /* 깨진 저장값은 무시 */
    }
    await Promise.all([get().refreshRepos(), get().refreshExecs(), get().refreshSessions()]);
    // 선택된 세션이 있으면 그 세션 워크트리로 포커스를 다시 맞춘다(저장 이후 워크트리가 바뀌었을 수 있음).
    const sel = get().selectedSessionId;
    const s = sel ? get().sessions.find((x) => x.id === sel) : null;
    if (s?.worktreePath && s.cwdExists) set({ focus: { worktreePath: s.worktreePath, source: "session" } });
    if (!get().focus) {
      const first = get().repos.find((r) => r.exists && r.worktrees.length);
      if (first) set({ focus: { worktreePath: first.worktrees[0].path, source: "manual" } });
    }
    set({ restored: true });
  },

  refreshRepos: async () => {
    try {
      set({ repos: await api.repoList() });
    } catch (e) {
      get().toast("error", `저장소 목록을 읽지 못했습니다: ${errorText(e)}`);
    }
  },

  refreshSessions: async () => {
    set({ sessionsLoading: true });
    try {
      const raw = await api.sessions();
      set({ rawSessions: raw, sessions: mergeSessions(raw, get().execs) });
      // 세션에서 저장소가 새로 발견되었을 수 있다.
      if (raw.some((s) => s.repoId && !get().repos.some((r) => r.id === s.repoId))) await get().refreshRepos();
    } catch (e) {
      get().toast("error", `세션 목록을 읽지 못했습니다: ${errorText(e)}`);
    } finally {
      set({ sessionsLoading: false });
    }
  },

  refreshExecs: async () => {
    const execs = await api.execList().catch(() => get().execs);
    set({ execs, sessions: mergeSessions(get().rawSessions, execs) });
    // 임시 항목(exec:<id>)을 보고 있었는데 실제 세션과 연결되었으면 선택을 옮긴다.
    const sel = get().selectedSessionId;
    if (sel?.startsWith("exec:")) {
      const linked = execs.find((e) => `exec:${e.id}` === sel && e.sessionId);
      if (linked?.sessionId) get().selectSession(linked.sessionId);
    }
  },

  selectSession: (id) => {
    const s = id ? get().sessions.find((x) => x.id === id) : null;
    const patch: Partial<State> = { selectedSessionId: id };
    // 세션의 워크트리로 포커스만 옮긴다. 체크아웃은 하지 않는다.
    if (s?.worktreePath && s.cwdExists) {
      if (get().focus?.worktreePath !== s.worktreePath) patch.viewer = null;
      patch.focus = { worktreePath: s.worktreePath, source: "session" };
    }
    set(patch);
    persist("selectedSession", id);
    if (patch.focus) persist("focus", patch.focus);
  },

  setFocusWorktree: (path) => {
    const focus: Focus = { worktreePath: path, source: "manual" };
    set({ focus, viewer: null });
    persist("focus", focus);
  },

  openViewer: (v) => set({ viewer: v }),

  toast: (kind, text) => {
    const id = toastSeq++;
    set({ toasts: [...get().toasts, { id, kind, text }] });
    setTimeout(() => get().dismissToast(id), kind === "error" ? 9000 : 4000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  ask: (req) =>
    new Promise<boolean>((resolve) => {
      set({
        confirm: {
          ...req,
          resolve: (ok) => {
            set({ confirm: null });
            resolve(ok);
          },
        },
      });
    }),

  setNewSessionOpen: (open) => set({ newSessionOpen: open }),

  onFsChanged: (worktree, paths, files, git) => {
    const focus = get().focus;
    const patch: Partial<State> = {
      worktreeActivity: { ...get().worktreeActivity, [worktree]: Date.now() },
    };
    if (focus?.worktreePath === worktree) {
      if (files) {
        patch.fsTick = get().fsTick + 1;
        patch.changedPaths = paths;
      }
      // 파일이 바뀌면 git 상태(수정 표시)도 바뀐다.
      patch.gitTick = get().gitTick + 1;
    }
    set(patch);
    if (git) {
      // 다른 워크트리의 브랜치가 바뀌었을 수 있으니 목록의 "현재 브랜치"를 갱신한다.
      void get().refreshRepos();
      void get().refreshSessions();
    }
  },

  bumpGit: () => set({ gitTick: get().gitTick + 1 }),
}));

/** 현재 포커스 워크트리가 속한 저장소 */
export function useFocusRepo(): RepoSummary | null {
  return useStore((s) => {
    const p = s.focus?.worktreePath;
    if (!p) return null;
    return s.repos.find((r) => r.worktrees.some((w) => w.path === p)) ?? null;
  });
}

export function useSelectedSession(): LinkedSession | null {
  return useStore((s) => (s.selectedSessionId ? s.sessions.find((x) => x.id === s.selectedSessionId) ?? null : null));
}

// 테스트 자동화·디버깅용: 화면 상태를 읽고 동작을 호출할 수 있게 노출한다(앱 안에서만 접근 가능).
(window as unknown as { __aitermStore: typeof useStore }).__aitermStore = useStore;
