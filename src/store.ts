// 앱 전역 상태. "focus" 하나를 세 패널이 함께 구독한다.
import { create } from "zustand";
import { api, errorText, type AppInfo, type ChatInfo, type ExecInfo, type LinkedSession, type LiveRun, type RepoSummary } from "./api";
import { mergeSessions } from "./logic";

/** 세 패널이 바라보는 워크트리. 조회 전용이며 절대 체크아웃을 일으키지 않는다. */
export interface Focus {
  worktreePath: string;
  /** 왜 이 워크트리를 보는지 */
  source: "session" | "manual";
}

export type Viewer =
  | { kind: "file"; rel: string; mode: "preview" | "diff" | "stage" }
  | { kind: "commit-file"; sha: string; rel: string }
  | null;

export interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  text: string;
}

export interface PromptField {
  key: string;
  label: string;
  value: string;
  placeholder?: string;
  /** select 로 보여 줄 선택지 */
  options?: { value: string; label: string }[];
  /** 체크박스 ("true"/"false") */
  checkbox?: boolean;
}

export interface PromptRequest {
  title: string;
  body?: string;
  fields: PromptField[];
  confirmLabel?: string;
  danger?: boolean;
  /** 오류 문구를 돌려주면 확인을 막는다 */
  validate?: (values: Record<string, string>) => string | null;
  resolve: (values: Record<string, string> | null) => void;
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
  /** 포커스 워크트리의 변경 신호 (값이 바뀌면 다시 읽는다)
   *  fsTick: 파일 내용/목록, statusTick: git status(파일 또는 git 변경), gitTick: HEAD·refs·워크트리(그래프) */
  fsTick: number;
  statusTick: number;
  /** 같은 워크트리를 다시 골랐을 때 감시를 다시 걸기 위한 신호 */
  watchNonce: number;
  gitTick: number;
  changedPaths: string[];
  /** 워크트리 → 최근 파일 변경 시각 (실행 중인 다른 세션 표시용) */
  worktreeActivity: Record<string, number>;
  toasts: Toast[];
  confirm: ConfirmRequest | null;
  prompt: PromptRequest | null;
  chats: ChatInfo[];
  liveRuns: LiveRun[];
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
  promptForm: (req: Omit<PromptRequest, "resolve">) => Promise<Record<string, string> | null>;
  refreshChats: () => Promise<void>;
  setLiveRuns: (runs: LiveRun[]) => void;
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
  statusTick: 0,
  watchNonce: 0,
  gitTick: 0,
  changedPaths: [],
  worktreeActivity: {},
  toasts: [],
  confirm: null,
  prompt: null,
  chats: [],
  liveRuns: [],
  newSessionOpen: false,
  restored: false,

  boot: async () => {
    const [info, focusRaw, selRaw] = await Promise.all([
      api.appInfo().catch(() => null),
      api.kvGet("focus").catch(() => null),
      api.kvGet("selectedSession").catch(() => null),
    ]);
    set({ info });
    if (info?.automation || import.meta.env.DEV) {
      exposeForAutomation();
      const { exposeTerminals } = await import("./panels/TerminalView");
      exposeTerminals();
    }
    try {
      if (focusRaw) set({ focus: JSON.parse(focusRaw) });
      if (selRaw) set({ selectedSessionId: JSON.parse(selRaw) });
    } catch {
      /* 깨진 저장값은 무시 */
    }
    await Promise.all([get().refreshRepos(), get().refreshExecs(), get().refreshSessions(), get().refreshChats()]);
    api.liveRuns().then((r) => set({ liveRuns: r }), () => {});
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

  refreshRepos: () =>
    coalesce("repos", async () => {
      const seq = ++repoSeq;
      try {
        const repos = await api.repoList();
        if (seq === repoSeq) set({ repos });
      } catch (e) {
        get().toast("error", `저장소 목록을 읽지 못했습니다: ${errorText(e)}`);
      }
    }),

  refreshSessions: () => coalesce("sessions", () => loadSessions()),

  refreshExecs: async () => {
    const execs = await api.execList().catch(() => get().execs);
    set({ execs, sessions: mergeSessions(get().rawSessions, execs, get().chats) });
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
    // 같은 워크트리를 다시 고르면 새로 읽는다(폴더를 지웠다 다시 만든 경우 등).
    const same = get().focus?.worktreePath === path;
    set({ focus, viewer: null, ...(same ? { gitTick: get().gitTick + 1, statusTick: get().statusTick + 1, fsTick: get().fsTick + 1, watchNonce: get().watchNonce + 1 } : {}) });
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

  promptForm: (req) =>
    new Promise((resolve) => {
      set({
        prompt: {
          ...req,
          resolve: (v) => {
            set({ prompt: null });
            resolve(v);
          },
        },
      });
    }),

  refreshChats: async () => {
    const chats = await api.chatList().catch(() => get().chats);
    set({ chats, sessions: mergeSessions(get().rawSessions, get().execs, chats) });
    // 새 채팅(임시 항목 chat:<id>)을 보고 있었는데 세션 id 가 정해졌으면 선택을 옮긴다.
    const sel = get().selectedSessionId;
    if (sel?.startsWith("chat:")) {
      const c = chats.find((x) => `chat:${x.id}` === sel && x.sessionId);
      if (c?.sessionId) {
        await get().refreshSessions();
        get().selectSession(c.sessionId);
      }
    }
  },

  setLiveRuns: (runs) => set({ liveRuns: runs }),

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
      // 파일이 바뀌면 status 만, .git 이 바뀌었을 때만 그래프(전체 log)를 다시 읽는다.
      patch.statusTick = get().statusTick + 1;
      if (git) patch.gitTick = get().gitTick + 1;
    }
    set(patch);
    if (git) {
      // 다른 워크트리의 브랜치가 바뀌었을 수 있으니 목록의 "현재 브랜치"를 갱신한다.
      void get().refreshRepos();
      void get().refreshSessions();
    }
  },

  bumpGit: () => set({ gitTick: get().gitTick + 1, statusTick: get().statusTick + 1 }),
}));

// ── 갱신 합치기 / 순서 보장 ──
// 이벤트가 몰려도 같은 갱신은 한 번에 하나만 돌고, 도는 중에 다시 요청되면 끝난 뒤 한 번만 더 돈다.
// 응답은 가장 최근 요청의 것만 반영한다(늦게 온 옛 결과가 새 결과를 덮지 않게).
const running = new Map<string, Promise<void>>();
const again = new Set<string>();
function coalesce(key: string, fn: () => Promise<void>): Promise<void> {
  const cur = running.get(key);
  if (cur) {
    again.add(key);
    return cur;
  }
  const p = (async () => {
    try {
      await fn();
    } finally {
      running.delete(key);
      if (again.delete(key)) void coalesce(key, fn);
    }
  })();
  running.set(key, p);
  return p;
}
let repoSeq = 0;
let sessionSeq = 0;

async function loadSessions() {
  const get = useStore.getState;
  const set = useStore.setState;
  const seq = ++sessionSeq;
  {
    set({ sessionsLoading: true });
    try {
      const raw = await api.sessions();
      if (seq !== sessionSeq) return;
      set({ rawSessions: raw, sessions: mergeSessions(raw, get().execs, get().chats) });
      // 세션에서 저장소가 새로 발견되었을 수 있다.
      if (raw.some((s) => s.repoId && !get().repos.some((r) => r.id === s.repoId))) await get().refreshRepos();
    } catch (e) {
      get().toast("error", `세션 목록을 읽지 못했습니다: ${errorText(e)}`);
    } finally {
      set({ sessionsLoading: false });
    }
  }
}


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

/** 테스트 자동화 빌드나 개발 모드에서만 화면 상태를 창 객체에 노출한다(배포 빌드에는 없음). */
export function exposeForAutomation() {
  (window as unknown as { __aitermStore: typeof useStore }).__aitermStore = useStore;
}
