// 앱 전역 상태. "focus" 하나를 세 패널이 함께 구독한다.
import { create } from "zustand";
import { lang, t } from "./i18n";
import { api, errorText, type AppInfo, type ChatInfo, type ExecInfo, type LinkedSession, type LiveRun, type RepoSummary } from "./api";
import { mergeSessions } from "./logic";
import { useExtensions } from "./extensions";

/** 세 패널이 바라보는 워크트리. 조회 전용이며 절대 체크아웃을 일으키지 않는다. */
export interface Focus {
  worktreePath: string;
  /** 왜 이 워크트리를 보는지 */
  source: "session" | "manual";
}

export type Viewer =
  /** mode 의 "ext:…" 는 확장 기능이 더한 탭(예: 파일 편집) */
  | { kind: "file"; rel: string; mode: "preview" | "diff" | "stage" | `ext:${string}` }
  | { kind: "commit-file"; sha: string; rel: string }
  | null;

/** 가운데 칸 탭으로 연 파일(파일 편집 기능을 켰을 때). 워크트리를 옮겨도 남는다. */
export interface FileTab {
  id: string;
  worktree: string;
  viewer: NonNullable<Viewer>;
}

export function fileTabId(worktree: string, v: NonNullable<Viewer>): string {
  return `${worktree}\u0000${v.kind === "commit-file" ? `${v.sha}:` : ""}${v.rel}`;
}

/** 파일 편집을 켜면 파일은 오른쪽 아래 대신 가운데 칸 탭으로 연다 */
function filesInMiddle(): boolean {
  const e = useExtensions.getState();
  return e.loaded && e.enabled.editor;
}

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
  /** 세 번째 버튼(예: "저장하지 않고 닫기"). 누르면 resolve("alt") */
  altLabel?: string;
  resolve: (ok: boolean | "alt") => void;
}

interface State {
  info: AppInfo | null;
  repos: RepoSummary[];
  openRepoIds: string[];
  repoTabPaths: Record<string, string>;
  repoTabSessions: Record<string, string>;
  openRepoTab: (id: string) => void;
  closeRepoTab: (id: string) => void;
  rawSessions: LinkedSession[];
  sessions: LinkedSession[];
  execs: ExecInfo[];
  sessionsLoading: boolean;
  selectedSessionId: string | null;
  focus: Focus | null;
  /** 오른쪽 파일 칸 아래에 연 파일(파일 편집이 꺼져 있을 때) */
  viewer: Viewer;
  fileTabs: FileTab[];
  /** 가운데 칸에서 보고 있는 파일 탭. null 이면 에이전트 */
  activeTab: string | null;
  /** 포커스 워크트리의 변경 신호 (값이 바뀌면 다시 읽는다)
   *  fsTick: 파일 내용/목록, statusTick: git status(파일 또는 git 변경), gitTick: HEAD·refs·워크트리(그래프) */
  fsTick: number;
  statusTick: number;
  /** 같은 워크트리를 다시 골랐을 때 감시를 다시 걸기 위한 신호 */
  watchNonce: number;
  gitTick: number;
  changedPaths: string[];
  /** 워크트리별 파일·.git 변경 신호(가운데 탭에 연 다른 워크트리 파일도 바깥 변경을 따라가게) */
  fsSignals: Record<string, { n: number; paths: string[] }>;
  gitSignals: Record<string, number>;
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
  /** 파일 보기 열기. 파일 편집이 켜져 있으면 가운데 칸 탭으로(keepMode: 이미 열린 탭이면 보던 탭 모드 그대로) */
  openViewer: (v: Viewer, opts?: { keepMode?: boolean }) => void;
  /** 탭 안에서 모드를 바꾸거나(v) 닫는다(null) */
  setTabViewer: (id: string, v: Viewer) => void;
  setActiveTab: (id: string | null) => void;
  /** 탭 여러 개를 한 번에 닫는다(저장 안 한 수정 확인은 부르는 쪽에서) */
  closeTabs: (ids: string[]) => void;
  toast: (kind: Toast["kind"], text: string) => void;
  dismissToast: (id: number) => void;
  ask: (req: Omit<ConfirmRequest, "resolve" | "altLabel">) => Promise<boolean>;
  /** 버튼 셋(취소·altLabel·confirmLabel) 확인창. 취소면 null */
  choose: (req: Omit<ConfirmRequest, "resolve"> & { altLabel: string }) => Promise<"confirm" | "alt" | null>;
  promptForm: (req: Omit<PromptRequest, "resolve">) => Promise<Record<string, string> | null>;
  refreshChats: () => Promise<void>;
  setLiveRuns: (runs: LiveRun[]) => void;
  setNewSessionOpen: (open: boolean) => void;
  onFsChanged: (worktree: string, paths: string[], files: boolean, git: boolean) => void;
  bumpGit: () => void;
  /** 앱이 직접 파일을 바꿨을 때(끌어다 놓기 복사·이동): 파일 감시를 기다리지 않고 트리·변경 목록을 다시 읽게 한다.
   *  감시가 무시하는 폴더(빌드 결과물 등)에 놓아도 보이도록. */
  bumpFs: (worktree: string, paths: string[]) => void;
}

let toastSeq = 1;

function persist(key: string, value: unknown) {
  api.kvSet(key, JSON.stringify(value)).catch(() => {});
}

export const useStore = create<State>((set, get) => ({
  info: null,
  repos: [],
  openRepoIds: [],
  repoTabPaths: {},
  repoTabSessions: {},
  rawSessions: [],
  sessions: [],
  execs: [],
  sessionsLoading: false,
  selectedSessionId: null,
  focus: null,
  viewer: null,
  fileTabs: [],
  activeTab: null,
  fsTick: 0,
  statusTick: 0,
  watchNonce: 0,
  gitTick: 0,
  changedPaths: [],
  fsSignals: {},
  gitSignals: {},
  worktreeActivity: {},
  toasts: [],
  confirm: null,
  prompt: null,
  chats: [],
  liveRuns: [],
  newSessionOpen: false,
  restored: false,

  boot: async () => {
    const [info, focusRaw, selRaw, tabsRaw] = await Promise.all([
      api.appInfo().catch(() => null),
      api.kvGet("focus").catch(() => null),
      api.kvGet("selectedSession").catch(() => null),
      api.kvGet("repoTabs").catch(() => null),
    ]);
    set({ info });
    void api.setLang(lang).catch(() => {});
    void useExtensions.getState().load();
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
    const keep = s && get().focus && s.otherWorktrees?.includes(get().focus!.worktreePath);
    if (s?.worktreePath && s.cwdExists && !keep) set({ focus: { worktreePath: s.worktreePath, source: "session" } });
    let ids: string[] | null = null;
    let paths: Record<string, string> = {};
    let tabSessions: Record<string, string> = {};
    try {
      const saved = JSON.parse(tabsRaw ?? "null");
      if (Array.isArray(saved?.ids)) {
        if (saved.sessions && typeof saved.sessions === "object") tabSessions = Object.fromEntries(Object.entries(saved.sessions).filter(([, v]) => typeof v === "string")) as Record<string, string>;
        ids = [...new Set<string>(saved.ids.filter((id: unknown) => typeof id === "string"))];
        if (saved.paths && typeof saved.paths === "object") paths = Object.fromEntries(Object.entries(saved.paths).filter(([, v]) => typeof v === "string")) as Record<string, string>;
      }
      if (!tabsRaw) {
        const legacy = JSON.parse(localStorage.getItem("aiterm.repoWorktrees") ?? "{}");
        if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) paths = Object.fromEntries(Object.entries(legacy).filter(([, v]) => typeof v === "string")) as Record<string, string>;
      }
    } catch { /* Invalid preferences fall back to the previously focused repository. */ }
    const active = get().repos.find((r) => r.worktrees.some((w) => w.path === get().focus?.worktreePath));
    ids = (ids ?? (active ? [active.id] : [])).filter((id) => get().repos.some((r) => r.id === id));
    set({ openRepoIds: ids, repoTabPaths: paths, repoTabSessions: tabSessions });
    if (!active || !ids.includes(active.id)) {
      set({ focus: null, selectedSessionId: null, viewer: null });
      if (ids.length) get().openRepoTab(ids[0]);
      else { persist("focus", null); persist("selectedSession", null); }
    }
    if (get().focus && get().selectedSessionId) rememberTab(get().focus!.worktreePath, get().selectedSessionId);
    persistTabs();
    set({ restored: true });
  },

  refreshRepos: () =>
    coalesce("repos", async () => {
      const seq = ++repoSeq;
      try {
        const repos = await api.repoList();
        if (seq === repoSeq) set({ repos });
      } catch (e) {
        get().toast("error", t("저장소 목록을 읽지 못했습니다: {error}", { error: errorText(e) }));
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
    const patch: Partial<State> = { selectedSessionId: id, activeTab: null };
    // 세션의 워크트리로 포커스만 옮긴다. 체크아웃은 하지 않는다.
    // 지금 보는 워크트리에서도 일한 세션이면(최근엔 다른 곳) 보던 곳을 유지한다.
    const keep = !!s && !!get().focus && !!s.otherWorktrees?.includes(get().focus!.worktreePath);
    if (s?.worktreePath && s.cwdExists && !keep) {
      if (get().focus?.worktreePath !== s.worktreePath) patch.viewer = null;
      patch.focus = { worktreePath: s.worktreePath, source: "session" };
    }
    set(patch);
    if (!patch.focus && get().focus) rememberTab(get().focus!.worktreePath, id);
    persist("selectedSession", id);
    if (patch.focus) { persist("focus", patch.focus); rememberTab(patch.focus.worktreePath, id); }
  },

  setFocusWorktree: (path) => {
    const focus: Focus = { worktreePath: path, source: "manual" };
    // 같은 워크트리를 다시 고르면 새로 읽는다(폴더를 지웠다 다시 만든 경우 등).
    const same = get().focus?.worktreePath === path;
    // 다른 폴더로 옮기면 이전 폴더의 세션 선택을 비운다(목록은 지금 폴더 것만 보이므로).
    const sel = get().selectedSessionId;
    const selWt = sel ? get().sessions.find((x) => x.id === sel)?.worktreePath : null;
    if (sel && selWt !== path) {
      set({ selectedSessionId: null });
      persist("selectedSession", null);
    }
    set({ focus, viewer: null, ...(same ? { gitTick: get().gitTick + 1, statusTick: get().statusTick + 1, fsTick: get().fsTick + 1, watchNonce: get().watchNonce + 1 } : {}) });
    persist("focus", focus);
    rememberTab(path);
  },

  openRepoTab: (id) => {
    const repo = get().repos.find((r) => r.id === id);
    const available = repo?.worktrees.filter((w) => w.exists && !w.bare) ?? [];
    const target = available.find((w) => w.path === get().repoTabPaths[id]) ?? available.find((w) => w.isMain) ?? available[0];
    if (!target) return;
    get().setFocusWorktree(target.path);
    const belongs = (session: LinkedSession) => session.worktreePath === target.path || session.otherWorktrees?.includes(target.path);
    const remembered = get().sessions.find((session) => session.id === get().repoTabSessions[id] && belongs(session));
    const running = get().sessions.filter(belongs).filter((session) => session.runningExecId || get().liveRuns.some((r) => r.sessionId === session.externalId || r.sessionId === session.id) || get().chats.some((c) => c.alive && (c.sessionId === session.id || `chat:${c.id}` === session.id))).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const session = remembered ?? running;
    if (session) get().selectSession(session.id);
  },
  closeRepoTab: (id) => {
    const previous = get().openRepoIds;
    const index = previous.indexOf(id);
    const ids = previous.filter((x) => x !== id);
    const active = get().repos.find((r) => r.id === id)?.worktrees.some((w) => w.path === get().focus?.worktreePath);
    set({ openRepoIds: ids });
    if (active) {
      set({ focus: null, selectedSessionId: null, viewer: null });
      persist("focus", null); persist("selectedSession", null);
      for (const next of [...ids.slice(index), ...ids.slice(0, index).reverse()]) {
        get().openRepoTab(next);
        if (get().focus) break;
      }
    }
    persistTabs();
  },

  openViewer: (v, opts) => {
    const wt = get().focus?.worktreePath;
    if (!v || !wt || !filesInMiddle()) return set({ viewer: v });
    const id = fileTabId(wt, v);
    const tabs = get().fileTabs;
    const has = tabs.find((x) => x.id === id);
    const fileTabs = has ? (opts?.keepMode ? tabs : tabs.map((x) => (x.id === id ? { ...x, viewer: v } : x))) : [...tabs, { id, worktree: wt, viewer: v }];
    set({ fileTabs, activeTab: id, viewer: null });
  },
  setTabViewer: (id, v) => {
    const tabs = get().fileTabs;
    if (v) return set({ fileTabs: tabs.map((x) => (x.id === id ? { ...x, viewer: v } : x)) });
    // 닫으면 옆 탭(없으면 에이전트)을 보여 준다
    const i = tabs.findIndex((x) => x.id === id);
    const rest = tabs.filter((x) => x.id !== id);
    const active = get().activeTab === id ? (rest[Math.min(i, rest.length - 1)]?.id ?? null) : get().activeTab;
    set({ fileTabs: rest, activeTab: active });
  },
  setActiveTab: (id) => set({ activeTab: id }),
  closeTabs: (ids) => {
    const tabs = get().fileTabs;
    const active = get().activeTab;
    const rest = tabs.filter((x) => !ids.includes(x.id));
    if (!active || !ids.includes(active)) return set({ fileTabs: rest });
    // 닫힌 지금 탭 자리에서 가장 가까운 남은 탭(없으면 에이전트)
    const i = tabs.findIndex((x) => x.id === active);
    const next = tabs.slice(i + 1).find((x) => !ids.includes(x.id)) ?? [...tabs.slice(0, i)].reverse().find((x) => !ids.includes(x.id));
    set({ fileTabs: rest, activeTab: next?.id ?? null });
  },

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
            resolve(ok === true);
          },
        },
      });
    }),

  choose: (req) =>
    new Promise((resolve) => {
      set({
        confirm: {
          ...req,
          resolve: (ok) => {
            set({ confirm: null });
            resolve(ok === "alt" ? "alt" : ok ? "confirm" : null);
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

  setLiveRuns: (runs) => {
    if (JSON.stringify(runs) !== JSON.stringify(get().liveRuns)) set({ liveRuns: runs });
  },

  setNewSessionOpen: (open) => set({ newSessionOpen: open }),

  onFsChanged: (worktree, paths, files, git) => {
    const focus = get().focus;
    const patch: Partial<State> = {
      worktreeActivity: { ...get().worktreeActivity, [worktree]: Date.now() },
    };
    if (files) patch.fsSignals = { ...get().fsSignals, [worktree]: { n: (get().fsSignals[worktree]?.n ?? 0) + 1, paths } };
    if (git) patch.gitSignals = { ...get().gitSignals, [worktree]: (get().gitSignals[worktree] ?? 0) + 1 };
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

  bumpFs: (worktree, paths) => {
    const patch: Partial<State> = { fsSignals: { ...get().fsSignals, [worktree]: { n: (get().fsSignals[worktree]?.n ?? 0) + 1, paths } } };
    if (get().focus?.worktreePath === worktree) {
      patch.fsTick = get().fsTick + 1;
      patch.statusTick = get().statusTick + 1;
      patch.changedPaths = paths;
    }
    set(patch);
  },
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
let lastSessionsKey = "";

async function loadSessions() {
  const get = useStore.getState;
  const set = useStore.setState;
  const seq = ++sessionSeq;
  {
    if (!get().sessionsLoading) set({ sessionsLoading: true });
    try {
      // 백엔드는 제목 없는 세션에 "(제목 없음)" 을 넣는다(세션 정보는 언어와 상관없이 캐시되므로 화면에서 번역)
      const raw = (await api.sessions()).map((s) => (s.title === "(제목 없음)" ? { ...s, title: t("(제목 없음)") } : s));
      if (seq !== sessionSeq) return;
      // 내용이 그대로면 상태를 바꾸지 않는다(다시 그리기·GPU 칠하기 없음). 에이전트가 일하는 동안 자주 불린다.
      const key = JSON.stringify(raw);
      if (key === lastSessionsKey) return;
      lastSessionsKey = key;
      set({ rawSessions: raw, sessions: mergeSessions(raw, get().execs, get().chats) });
      // 세션에서 저장소가 새로 발견되었을 수 있다.
      if (raw.some((s) => s.repoId && !get().repos.some((r) => r.id === s.repoId))) await get().refreshRepos();
    } catch (e) {
      get().toast("error", t("세션 목록을 읽지 못했습니다: {error}", { error: errorText(e) }));
    } finally {
      if (get().sessionsLoading) set({ sessionsLoading: false });
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
/** 이 워크트리에서 지금 보이는 파일 보기(오른쪽 아래, 또는 가운데 칸의 지금 탭) — 목록의 선택 표시용 */
export function useShownViewer(worktree: string | null | undefined): Viewer {
  return useStore((s) => {
    if (s.viewer) return s.viewer;
    const tab = s.activeTab ? s.fileTabs.find((x) => x.id === s.activeTab) : undefined;
    return tab && tab.worktree === worktree ? tab.viewer : null;
  });
}

// 파일 편집을 끄면 가운데 탭을 닫고(지금 탭은 오른쪽 아래로), 켜면 오른쪽 아래에 열린 파일을 탭으로 옮긴다
useExtensions.subscribe((now, prev) => {
  const on = now.loaded && now.enabled.editor;
  if (on === (prev.loaded && prev.enabled.editor)) return;
  const s = useStore.getState();
  if (on) {
    if (s.viewer) {
      const v = s.viewer;
      useStore.setState({ viewer: null });
      s.openViewer(v);
    }
    return;
  }
  const tab = s.fileTabs.find((x) => x.id === s.activeTab);
  useStore.setState({ fileTabs: [], activeTab: null, viewer: tab && tab.worktree === s.focus?.worktreePath ? tab.viewer : s.viewer });
});

export function exposeForAutomation() {
  (window as unknown as { __aitermStore: typeof useStore }).__aitermStore = useStore;
  (window as unknown as { __aitermExt: typeof useExtensions }).__aitermExt = useExtensions;
}

function rememberTab(path: string, selected?: string | null) {
  const state = useStore.getState();
  const repo = state.repos.find((r) => r.worktrees.some((w) => w.path === path));
  if (!repo) return;
  const ids = state.openRepoIds.includes(repo.id) ? state.openRepoIds : [...state.openRepoIds, repo.id];
  const paths = { ...state.repoTabPaths, [repo.id]: path };
  const sessions = { ...state.repoTabSessions };
  if (selected) sessions[repo.id] = selected;
  else if (selected === null) delete sessions[repo.id];
  useStore.setState({ openRepoIds: ids, repoTabPaths: paths, repoTabSessions: sessions });
  persistTabs();
}

function persistTabs() {
  const s = useStore.getState();
  persist("repoTabs", { ids: s.openRepoIds, paths: s.repoTabPaths, sessions: s.repoTabSessions });
}
