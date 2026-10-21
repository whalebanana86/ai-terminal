// 브랜치·워크트리·병합 같은 Git 쓰기 작업. 그래프 메뉴, 브랜치 탭, 브랜치 전환 메뉴가 모두 이 함수를 쓴다.
// 모든 작업은 확인창을 거치며, 커밋하지 않은 변경·실행 중인 에이전트가 있으면 위험 표시를 한다.
import { api, errorText, type GitRef, type Worktree } from "./api";
import { baseName, checkoutWarning } from "./logic";
import { useStore } from "./store";

const st = () => useStore.getState();

async function dirtyCount(worktree: string): Promise<number> {
  const s = await api.status(worktree).catch(() => null);
  return s?.entries.filter((e) => e.kind !== "ignored").length ?? 0;
}

function agentsIn(worktree: string): number {
  const s = st();
  const app = s.sessions.filter((x) => x.runningExecId && x.worktreePath === worktree).length;
  const chats = s.chats.filter((c) => c.cwd === worktree || c.cwd.startsWith(worktree + "/")).length;
  const ext = s.liveRuns.filter((r) => !r.ownedByApp && r.cwd && (r.cwd === worktree || r.cwd.startsWith(worktree + "/"))).length;
  return app + chats + ext;
}

function afterChange() {
  const s = st();
  s.bumpGit();
  void s.refreshRepos();
  void s.refreshSessions();
}

async function run<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    const r = await fn();
    st().toast("success", `${label} 완료`);
    return r;
  } catch (e) {
    st().toast("error", `${label} 실패: ${errorText(e)}`);
    return null;
  } finally {
    afterChange();
  }
}

/** 다른 워크트리가 이미 쓰는 브랜치면 그 워크트리 */
function usedElsewhere(branch: string, worktree: string, worktrees: Worktree[]): Worktree | undefined {
  return worktrees.find((w) => w.branch === branch && w.path !== worktree);
}

/** 브랜치(로컬/원격) 또는 커밋으로 체크아웃 */
export async function checkout(worktree: string, target: string, kind: "branch" | "remote" | "commit", worktrees: Worktree[]) {
  const local = kind === "remote" ? target.split("/").slice(1).join("/") : target;
  if (kind !== "commit") {
    const other = usedElsewhere(local, worktree, worktrees);
    if (other) {
      const go = await st().ask({
        title: `${local} 은(는) 다른 워크트리에서 쓰는 중`,
        body: `Git 은 한 브랜치를 두 워크트리에서 동시에 열 수 없어요.\n${other.path}\n\n그 워크트리를 대신 볼까요? (화면만 옮기고 체크아웃하지 않아요)`,
        confirmLabel: "그 워크트리 보기",
      });
      if (go) st().setFocusWorktree(other.path);
      return;
    }
  }
  const warn = checkoutWarning(await dirtyCount(worktree), target, agentsIn(worktree));
  const ok = await st().ask({
    title: kind === "commit" ? "커밋으로 이동 (브랜치 없음 상태)" : `${local} 로 전환 (체크아웃)`,
    body:
      `워크트리 ${baseName(worktree)} 를 ${kind === "commit" ? "커밋 " + target.slice(0, 10) + " (브랜치 없음 상태)" : local} 로 바꿉니다.` +
      (kind === "remote" ? `\n로컬 브랜치가 없으면 ${target} 를 추적하는 '${local}' 을 만듭니다.` : "") +
      `\n워크트리 안의 파일이 그 브랜치 내용으로 바뀌어요.${warn ? "\n\n⚠ " + warn : ""}`,
    danger: !!warn,
    confirmLabel: "전환",
  });
  if (!ok) return;
  await run("전환", () => api.checkout(worktree, target, kind));
}

/** 현재 워크트리를 건드리지 않고 새 워크트리에서 브랜치를 연다(에이전트 병렬 작업에 권장). */
export async function newWorktree(repoPath: string, opts: { base?: string; existingBranch?: string; suggestName?: string }) {
  const main = repoPath.replace(/\/+$/, "");
  const parent = main.slice(0, main.lastIndexOf("/"));
  const repoName = baseName(main);
  const slug = (opts.existingBranch ?? opts.suggestName ?? "work").replace(/[^A-Za-z0-9._-]+/g, "-");
  const values = await st().promptForm({
    title: opts.existingBranch ? `'${opts.existingBranch}' 을(를) 새 워크트리로 열기` : "새 워크트리",
    body: opts.existingBranch
      ? "지금 워크트리는 그대로 두고, 새 워크트리(별도 폴더)에서 이 브랜치를 엽니다."
      : `${opts.base ?? "HEAD"} 에서 새 브랜치를 만들어 새 워크트리(별도 폴더)에서 엽니다. 지금 워크트리는 바뀌지 않습니다.`,
    fields: [
      ...(opts.existingBranch ? [] : [{ key: "branch", label: "새 브랜치 이름", value: opts.suggestName ?? "", placeholder: "feature/agent-task" }]),
      { key: "path", label: "폴더 위치", value: `${parent}/${repoName}-${slug}` },
    ],
    confirmLabel: "만들기",
    validate: (v) => {
      if (!opts.existingBranch && !v.branch.trim()) return "브랜치 이름을 입력하세요";
      if (!v.path.startsWith("/")) return "절대 경로를 입력하세요";
      return null;
    },
  });
  if (!values) return null;
  const branch = opts.existingBranch ? null : values.branch.trim();
  const base = opts.existingBranch ?? opts.base ?? null;
  const res = await run("워크트리 만들기", () => api.worktreeAdd(repoPath, values.path.trim(), branch, base));
  if (res !== null) {
    await st().refreshRepos();
    // 만든 워크트리를 바로 본다(체크아웃이 아니라 화면 이동). /tmp 같은 링크 경로는 Git 이 실제 경로로 적는다.
    const want = values.path.trim().replace(/\/+$/, "");
    const all = st().repos.flatMap((r) => r.worktrees);
    const hit = all.find((w) => w.path === want) ?? all.find((w) => w.path.endsWith(want) || w.path === "/private" + want);
    if (hit) st().setFocusWorktree(hit.path);
  }
  return res;
}

export async function removeWorktree(repoPath: string, wt: Worktree) {
  if (wt.isMain) return st().toast("error", "메인 워크트리는 지울 수 없습니다");
  if (!wt.exists) {
    // 폴더가 이미 없으면 등록만 정리한다
    const ok = await st().ask({ title: "사라진 워크트리 정리", body: `${wt.path}\n폴더가 없습니다. 워크트리 등록을 정리합니다(git worktree prune).`, confirmLabel: "정리" });
    if (ok) await run("워크트리 정리", () => api.worktreePrune(repoPath));
    return;
  }
  const dirty = wt.exists ? await dirtyCount(wt.path) : 0;
  const agents = agentsIn(wt.path);
  const values = await st().promptForm({
    title: `워크트리 삭제: ${baseName(wt.path)}`,
    body:
      `${wt.path}\n폴더를 지우고 워크트리 등록을 해제합니다. 브랜치 '${wt.branch ?? "(브랜치 없음)"}' 의 커밋은 남아요.` +
      (dirty ? `\n\n⚠ 커밋하지 않은 변경 ${dirty}개가 있습니다. 지우면 되돌릴 수 없습니다.` : "") +
      (agents ? `\n⚠ 이 워크트리에서 에이전트 ${agents}개가 실행 중입니다.` : ""),
    fields: [
      ...(dirty ? [{ key: "force", label: `변경 ${dirty}개를 버리고 삭제`, value: "false", checkbox: true }] : []),
      ...(wt.branch ? [{ key: "deleteBranch", label: `브랜치 '${wt.branch}' 도 삭제 (병합된 경우만)`, value: "false", checkbox: true }] : []),
    ],
    danger: true,
    confirmLabel: "삭제",
    validate: (v) => (dirty && v.force !== "true" ? "변경을 버리는 데 동의해야 삭제할 수 있습니다" : null),
  });
  if (!values) return;
  const focus = st().focus?.worktreePath;
  const force = values.force === "true";
  let res: string | null = null;
  try {
    res = await api.worktreeRemove(repoPath, wt.path, force);
  } catch (e) {
    const m = /EXTERNAL_AGENTS:(\d+)/.exec(errorText(e));
    if (!m) {
      st().toast("error", `워크트리 삭제 실패: ${errorText(e)}`);
      afterChange();
      return;
    }
    const go = await st().ask({
      title: "외부 에이전트가 실행 중",
      body: `이 워크트리에서 앱 밖의 에이전트 ${m[1]}개가 실행 중입니다. 폴더를 지우면 그 에이전트가 하던 작업이 깨집니다.\n그래도 삭제할까요?`,
      danger: true,
      confirmLabel: "그래도 삭제",
    });
    if (!go) return;
    res = await run("워크트리 삭제", () => api.worktreeRemove(repoPath, wt.path, force, true));
  }
  if (res !== null) st().toast("success", "워크트리 삭제 완료");
  afterChange();
  if (res !== null && values.deleteBranch === "true" && wt.branch) {
    await run(`브랜치 '${wt.branch}' 삭제`, () => api.branchDelete(repoPath, wt.branch!, false));
  }
  if (res !== null && focus === wt.path) st().setFocusWorktree(repoPath);
}

export async function createBranch(worktree: string, start: string, startLabel: string) {
  const values = await st().promptForm({
    title: "새 브랜치",
    body: `${startLabel} 에서 시작합니다.`,
    fields: [
      { key: "name", label: "브랜치 이름", value: "", placeholder: "feature/..." },
      { key: "checkout", label: "만든 뒤 지금 워크트리를 이 브랜치로 전환", value: "false", checkbox: true },
    ],
    confirmLabel: "만들기",
    validate: (v) => (v.name.trim() ? null : "이름을 입력하세요"),
  });
  if (!values) return;
  if (values.checkout === "true") {
    const warn = checkoutWarning(await dirtyCount(worktree), values.name, agentsIn(worktree));
    if (warn && !(await st().ask({ title: "체크아웃 확인", body: `⚠ ${warn}`, danger: true, confirmLabel: "만들고 체크아웃" }))) return;
  }
  await run("브랜치 만들기", () => api.branchCreate(worktree, values.name.trim(), start, values.checkout === "true"));
}

export async function deleteBranch(repoPath: string, ref: GitRef) {
  const ok = await st().ask({
    title: `브랜치 '${ref.short}' 삭제`,
    body: "병합된 브랜치만 지웁니다(git branch -d). 병합되지 않은 커밋이 있으면 Git 이 거부합니다.",
    danger: true,
    confirmLabel: "삭제",
  });
  if (!ok) return;
  await run("브랜치 삭제", () => api.branchDelete(repoPath, ref.short, false));
}

/** 현재 브랜치에 target 을 병합 */
export async function merge(worktree: string, current: string | null, target: string) {
  if (!current) return st().toast("error", "브랜치가 없는 상태에서는 병합할 수 없어요. 먼저 브랜치로 전환하세요.");
  const cmp = await api.compare(worktree, current, target).catch(() => null);
  if (cmp && cmp.behind === 0) return st().toast("info", `'${target}' 의 커밋이 이미 '${current}' 에 모두 들어 있습니다`);
  const warn = checkoutWarning(await dirtyCount(worktree), current, agentsIn(worktree));
  const values = await st().promptForm({
    title: `${target} → ${current} 병합`,
    body:
      `${target} 에만 있는 커밋 ${cmp?.behind ?? "?"}개를 ${current} 로 가져옵니다.` +
      (cmp?.fastForward ? "\n지금은 병합 커밋 없이 앞으로 이동만 하면 됩니다." : "") +
      "\n충돌이 나면 멈추고, 해결한 뒤 계속하거나 중단할 수 있습니다." +
      (warn ? `\n\n⚠ ${warn}` : ""),
    fields: [
      {
        key: "mode",
        label: "방식",
        value: "ff",
        options: [
          { value: "ff", label: "가능하면 그냥 앞으로 이동 (기본, fast-forward)" },
          { value: "no-ff", label: "항상 병합 커밋 만들기 (--no-ff)" },
          { value: "ff-only", label: "앞으로 이동만, 안 되면 취소 (--ff-only)" },
        ],
      },
    ],
    danger: !!warn,
    confirmLabel: "병합",
  });
  if (!values) return;
  const r = await run("병합", () => api.merge(worktree, target, values.mode as "ff" | "no-ff" | "ff-only"));
  if (r?.conflict) st().toast("error", "충돌이 생겼습니다. Git 패널 위쪽에서 파일별로 해결한 뒤 '계속'을 누르세요.");
}

/** 현재 브랜치를 onto 위로 rebase */
export async function rebase(worktree: string, current: string | null, onto: string, upstream: string | null) {
  if (!current) return st().toast("error", "브랜치가 없는 상태에서는 리베이스할 수 없어요.");
  const cmp = await api.compare(worktree, current, onto).catch(() => null);
  if (cmp && cmp.behind === 0) return st().toast("info", `'${current}' 은(는) 이미 '${onto}' 위에 있습니다`);
  // 이미 push 한 커밋을 다시 쓰는지
  const pushed = upstream ? await api.compare(worktree, current, upstream).catch(() => null) : null;
  const rewritesPushed = !!upstream && !!cmp && (pushed ? pushed.ahead < cmp.ahead : true);
  const warn = checkoutWarning(await dirtyCount(worktree), current, agentsIn(worktree));
  const ok = await st().ask({
    title: `${current} 를 ${onto} 위로 리베이스`,
    body:
      `${current} 에만 있는 커밋 ${cmp?.ahead ?? "?"}개를 ${onto} 의 최신 커밋(${cmp?.behind ?? "?"}개 앞) 위에 다시 씁니다. 커밋 해시가 바뀝니다.` +
      (rewritesPushed ? `\n\n⚠ 이미 ${upstream} 에 push 한 커밋도 다시 쓰게 됩니다. 이후 push 에는 강제 푸시가 필요하고, 다른 사람의 작업과 충돌할 수 있습니다.` : "") +
      (warn ? `\n\n⚠ ${warn}` : ""),
    danger: rewritesPushed || !!warn,
    confirmLabel: "리베이스",
  });
  if (!ok) return;
  const r = await run("리베이스", () => api.rebase(worktree, onto));
  if (r?.conflict) st().toast("error", "리베이스 중 충돌이 생겼어요. Git 패널 위쪽에서 해결한 뒤 '계속', 건너뛰려면 '건너뛰기', 원래대로 하려면 '중단'.");
}
