// Rust 명령과 1:1 로 대응하는 타입 있는 호출 계층.
import { Channel, invoke } from "@tauri-apps/api/core";

export type Agent = "claude" | "codex";

export interface AppInfo {
  version: string;
  git: string | null;
  gitVersion: string | null;
  claude: string | null;
  codex: string | null;
  claudeDir: string;
  codexDir: string;
  dataDir: string;
  automation: boolean;
}

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  isMain: boolean;
  locked: string | null;
  prunable: string | null;
  exists: boolean;
}

export interface RepoSummary {
  id: string;
  path: string;
  name: string;
  pinned: boolean;
  addedAt: number;
  exists: boolean;
  worktrees: Worktree[];
  error: string | null;
}

export interface SessionMeta {
  id: string;
  agent: Agent;
  externalId: string;
  title: string;
  firstPrompt: string | null;
  cwd: string | null;
  lastCwd: string | null;
  startBranch: string | null;
  lastBranch: string | null;
  createdAt: number;
  updatedAt: number;
  sourcePath: string;
  archived: boolean;
  origin: string | null;
}

export interface LinkedSession extends SessionMeta {
  repoId: string | null;
  repoName: string | null;
  worktreePath: string | null;
  /** 기록에 적힌 형태의 워크트리 경로(/tmp → /private/tmp 같은 심볼릭 링크일 때만) */
  worktreeAlias: string | null;
  /** 대화 도중 다른 워크트리로 옮겨 감 → 시작 브랜치는 다른 곳의 값 */
  cwdMoved: boolean;
  cwdExists: boolean;
  currentBranch: string | null;
  currentHead: string | null;
  currentDetached: boolean;
  runningExecId: string | null;
}

export interface Segment {
  fromLane: number;
  fromY: 0 | 1 | 2;
  toLane: number;
  toY: 0 | 1 | 2;
  color: number;
}

export interface GraphRow {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  subject: string;
  lane: number;
  color: number;
  segments: Segment[];
  width: number;
}

export interface GitRef {
  name: string;
  short: string;
  kind: "branch" | "remote" | "tag";
  target: string;
  upstream: string | null;
  track: string | null;
}

export interface GraphData {
  rows: GraphRow[];
  refs: GitRef[];
  worktrees: Worktree[];
  limit: number;
  truncated: boolean;
  head: string | null;
  headBranch: string | null;
}

export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted" | "ignored";

export interface StatusEntry {
  path: string;
  origPath: string | null;
  index: string;
  worktree: string;
  kind: ChangeKind;
}

export interface WorktreeStatus {
  head: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: StatusEntry[];
  operation: string | null;
}

export interface CommitDetail {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  committer: string;
  commitTime: number;
  message: string;
  files: StatusEntry[];
}

export interface DiffLine {
  kind: " " | "+" | "-" | "\\";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  binary: boolean;
  hunks: { header: string; lines: DiffLine[]; id: string }[];
  additions: number;
  deletions: number;
}

export interface DirEntry {
  name: string;
  rel: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  ignored: boolean;
}

export interface FileContent {
  rel: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  text: string | null;
}

export interface TranscriptItem {
  kind: "user" | "assistant" | "tool";
  text: string;
  tool: string | null;
  timestamp: number | null;
  isError: boolean;
}

export interface TouchedFile {
  path: string;
  op: string;
  count: number;
  lastAt: number | null;
}

export interface Transcript {
  items: TranscriptItem[];
  total: number;
  touchedFiles: TouchedFile[];
}

export interface ExecInfo {
  id: string;
  sessionId: string | null;
  agent: Agent;
  kind: "new" | "resume";
  cwd: string;
  worktreePath: string | null;
  branchAtStart: string | null;
  headAtStart: string | null;
  startedAt: number;
  pid: number | null;
  exited: boolean;
  exitCode: number | null;
}

export interface ChangeBatch {
  worktree: string;
  paths: string[];
  files: boolean;
  git: boolean;
}

export interface LiveRun {
  sessionId: string;
  agent: Agent;
  pid: number;
  /** cli | sdk | desktop | app-server | vscode */
  client: string;
  status: string | null;
  cwd: string | null;
  startedAt: number;
  ownedByApp: boolean;
}

export interface ChatInfo {
  id: string;
  agent: Agent;
  sessionId: string | null;
  cwd: string;
  busy: boolean;
  mode: string;
  alive: boolean;
  pid: number | null;
}

export type ChatEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id: string; name: string; summary: string; status: "running" | "ok" | "error"; output: string | null }
  | { kind: "permission"; requestId: string; tool: string; summary: string; description: string | null; input: unknown }
  | { kind: "permissionResolved"; requestId: string; allowed: boolean }
  | { kind: "fileChange"; paths: string[] }
  | { kind: "turnEnd"; costUsd: number | null; isError: boolean; text: string | null }
  | { kind: "error"; text: string }
  | { kind: "exit"; code: number | null };

export interface Compare {
  ahead: number;
  behind: number;
  mergeBase: string | null;
  fastForward: boolean;
}

export interface OpResult {
  conflict: boolean;
  output: string;
}

export interface OpState {
  operation: string | null;
  step: [number, number] | null;
  onto: string | null;
  conflicted: string[];
}

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  repoList: () => invoke<RepoSummary[]>("repo_list"),
  repoAdd: (path: string) => invoke<{ id: string; path: string; name: string; pinned: boolean }>("repo_add", { path }),
  repoSetPinned: (id: string, pinned: boolean) => invoke<void>("repo_set_pinned", { id, pinned }),
  worktrees: (path: string) => invoke<Worktree[]>("git_worktrees", { path }),
  graph: (path: string, limit?: number) => invoke<GraphData>("git_graph", { path, limit }),
  status: (path: string) => invoke<WorktreeStatus>("git_status", { path }),
  commitDetail: (path: string, sha: string) => invoke<CommitDetail>("git_commit_detail", { path, sha }),
  diffFile: (path: string, rel: string) => invoke<FileDiff[]>("git_diff_file", { path, rel }),
  diffCommitFile: (path: string, sha: string, rel: string) =>
    invoke<FileDiff[]>("git_diff_commit_file", { path, sha, rel }),
  remotes: (path: string) => invoke<string[]>("git_remotes", { path }),
  fetch: (path: string) => invoke<string>("git_fetch", { path }),
  pull: (path: string) => invoke<string>("git_pull", { path }),
  push: (path: string, setUpstreamRemote?: string) => invoke<string>("git_push", { path, setUpstreamRemote }),
  commit: (path: string, paths: string[], message: string) => invoke<string>("git_commit", { path, paths, message }),
  checkout: (path: string, target: string, kind: "branch" | "remote" | "commit") =>
    invoke<string>("git_checkout", { path, target, kind }),
  fsList: (worktree: string, rel: string) => invoke<DirEntry[]>("fs_list", { worktree, rel }),
  fsRead: (worktree: string, rel: string) => invoke<FileContent>("fs_read", { worktree, rel }),
  sessions: () => invoke<LinkedSession[]>("sessions_list"),
  transcript: (id: string) => invoke<Transcript>("session_transcript", { id }),
  execStart: (args: { agent: Agent; mode: "new" | "resume"; sessionId?: string; cwd?: string; cols: number; rows: number; force?: boolean; prompt?: string }) =>
    invoke<ExecInfo>("exec_start", { args }),
  execAttach: (id: string, onData: Channel<ArrayBuffer | number[] | string>) => invoke<number>("exec_attach", { id, onData }),
  execDetach: (id: string, sinkId: number) => invoke<void>("exec_detach", { id, sinkId }),
  execWrite: (id: string, data: string) => invoke<void>("exec_write", { id, data }),
  execResize: (id: string, cols: number, rows: number) => invoke<void>("exec_resize", { id, cols, rows }),
  execKill: (id: string) => invoke<void>("exec_kill", { id }),
  execList: () => invoke<ExecInfo[]>("exec_list"),
  watchSet: (worktrees: string[]) => invoke<void>("watch_set", { worktrees }),
  kvGet: (key: string) => invoke<string | null>("kv_get", { key }),
  kvSet: (key: string, value: string) => invoke<void>("kv_set", { key, value }),
  revealInFinder: (path: string) => invoke<void>("reveal_in_finder", { path }),

  liveRuns: () => invoke<LiveRun[]>("live_runs"),

  chatStart: (args: { agent: Agent; sessionId?: string; cwd?: string; mode: string; force?: boolean }) => invoke<ChatInfo>("chat_start", { args }),
  chatAttach: (id: string, onEvent: Channel<ChatEvent>) => invoke<number>("chat_attach", { id, onEvent }),
  chatDetach: (id: string, sinkId: number) => invoke<void>("chat_detach", { id, sinkId }),
  chatSend: (id: string, text: string) => invoke<void>("chat_send", { id, text }),
  chatPermission: (id: string, requestId: string, allow: boolean) => invoke<void>("chat_permission", { id, requestId, allow }),
  chatInterrupt: (id: string) => invoke<void>("chat_interrupt", { id }),
  chatClose: (id: string) => invoke<void>("chat_close", { id }),
  chatList: () => invoke<ChatInfo[]>("chat_list"),

  branchCreate: (path: string, name: string, start: string | null, checkout: boolean) =>
    invoke<string>("git_branch_create", { path, name, start, checkout }),
  branchDelete: (path: string, name: string, force: boolean) => invoke<string>("git_branch_delete", { path, name, force }),
  compare: (path: string, a: string, b: string) => invoke<Compare>("git_compare", { path, a, b }),
  worktreeAdd: (path: string, target: string, newBranch: string | null, base: string | null) =>
    invoke<string>("git_worktree_add", { path, target, newBranch, base }),
  worktreeRemove: (path: string, target: string, force: boolean, ignoreAgents = false) =>
    invoke<string>("git_worktree_remove", { path, target, force, ignoreAgents }),
  worktreePrune: (path: string) => invoke<string>("git_worktree_prune", { path }),
  diffSplit: (path: string, rel: string) => invoke<[FileDiff[], FileDiff[]]>("git_diff_split", { path, rel }),
  hunk: (path: string, rel: string, action: "stage" | "unstage" | "discard", index: number, hunkId: string) =>
    invoke<void>("git_hunk", { path, rel, action, index, hunkId }),
  stage: (path: string, paths: string[]) => invoke<void>("git_stage", { path, paths }),
  unstage: (path: string, paths: string[]) => invoke<void>("git_unstage", { path, paths }),
  discard: (path: string, paths: string[]) => invoke<void>("git_discard", { path, paths }),
  commitStaged: (path: string, message: string, amend: boolean) => invoke<string>("git_commit_staged", { path, message, amend }),
  merge: (path: string, target: string, mode: "ff" | "no-ff" | "ff-only") => invoke<OpResult>("git_merge", { path, target, mode }),
  rebase: (path: string, onto: string) => invoke<OpResult>("git_rebase", { path, onto }),
  opControl: (path: string, action: "continue" | "abort" | "skip") => invoke<OpResult>("git_op_control", { path, action }),
  resolve: (path: string, rel: string, side: "ours" | "theirs" | "mark") => invoke<void>("git_resolve", { path, rel, side }),
  opState: (path: string) => invoke<OpState>("git_op_state", { path }),
};

/** 외부 실행 중이라 거부된 오류인지 → { pid, client } */
export function externalRunning(e: unknown): { pid: string; client: string } | null {
  const m = /EXTERNAL_RUNNING:(\d+):(\S+)/.exec(errorText(e));
  return m ? { pid: m[1], client: m[2] } : null;
}

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
