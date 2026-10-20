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
  hunks: { header: string; lines: DiffLine[] }[];
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

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  repoList: () => invoke<RepoSummary[]>("repo_list"),
  repoAdd: (path: string) => invoke<RepoSummary>("repo_add", { path }),
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
  execStart: (args: { agent: Agent; mode: "new" | "resume"; sessionId?: string; cwd?: string; cols: number; rows: number }) =>
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
};

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
