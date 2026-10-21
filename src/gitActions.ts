// 브랜치·워크트리·병합 같은 Git 쓰기 작업. 그래프 메뉴, 브랜치 탭, 브랜치 전환 메뉴가 모두 이 함수를 쓴다.
// 모든 작업은 확인창을 거치며, 커밋하지 않은 변경·실행 중인 에이전트가 있으면 위험 표시를 한다.
import { api, errorText, type GitRef, type Worktree } from "./api";
import { t } from "./i18n";
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

/** label 은 이미 번역된 작업 이름 */
async function run<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    const r = await fn();
    st().toast("success", t("{label} 완료", { label }));
    return r;
  } catch (e) {
    st().toast("error", t("{label} 실패: {error}", { label, error: errorText(e) }));
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
        title: t("{branch} 은(는) 다른 워크트리에서 쓰는 중", { branch: local }),
        body: t("Git 은 한 브랜치를 두 워크트리에서 동시에 열 수 없어요.\n{path}\n\n그 워크트리를 대신 볼까요? (화면만 옮기고 체크아웃하지 않아요)", { path: other.path }),
        confirmLabel: t("그 워크트리 보기"),
      });
      if (go) st().setFocusWorktree(other.path);
      return;
    }
  }
  const warn = checkoutWarning(await dirtyCount(worktree), target, agentsIn(worktree));
  const ok = await st().ask({
    title: kind === "commit" ? t("커밋으로 이동 (브랜치 없음 상태)") : t("{branch} 로 전환 (체크아웃)", { branch: local }),
    body:
      (kind === "commit"
        ? t("워크트리 {worktree} 를 커밋 {commit} (브랜치 없음 상태) 로 바꿉니다.", { worktree: baseName(worktree), commit: target.slice(0, 10) })
        : t("워크트리 {worktree} 를 {branch} 로 바꿉니다.", { worktree: baseName(worktree), branch: local })) +
      (kind === "remote" ? "\n" + t("로컬 브랜치가 없으면 {remote} 를 추적하는 '{branch}' 을 만듭니다.", { remote: target, branch: local }) : "") +
      "\n" +
      t("워크트리 안의 파일이 그 브랜치 내용으로 바뀌어요.") +
      (warn ? "\n\n⚠ " + warn : ""),
    danger: !!warn,
    confirmLabel: t("전환"),
  });
  if (!ok) return;
  await run(t("전환"), () => api.checkout(worktree, target, kind));
}

/** 현재 워크트리를 건드리지 않고 새 워크트리에서 브랜치를 연다(에이전트 병렬 작업에 권장). */
export async function newWorktree(repoPath: string, opts: { base?: string; existingBranch?: string; suggestName?: string }) {
  const main = repoPath.replace(/\/+$/, "");
  const parent = main.slice(0, main.lastIndexOf("/"));
  const repoName = baseName(main);
  const slug = (opts.existingBranch ?? opts.suggestName ?? "work").replace(/[^A-Za-z0-9._-]+/g, "-");
  const values = await st().promptForm({
    title: opts.existingBranch ? t("'{branch}' 을(를) 새 워크트리로 열기", { branch: opts.existingBranch }) : t("새 워크트리"),
    body: opts.existingBranch
      ? t("지금 워크트리는 그대로 두고, 새 워크트리(별도 폴더)에서 이 브랜치를 엽니다.")
      : t("{base} 에서 새 브랜치를 만들어 새 워크트리(별도 폴더)에서 엽니다. 지금 워크트리는 바뀌지 않습니다.", { base: opts.base ?? "HEAD" }),
    fields: [
      ...(opts.existingBranch ? [] : [{ key: "branch", label: t("새 브랜치 이름"), value: opts.suggestName ?? "", placeholder: "feature/agent-task" }]),
      { key: "path", label: t("폴더 위치"), value: `${parent}/${repoName}-${slug}` },
    ],
    confirmLabel: t("만들기"),
    validate: (v) => {
      if (!opts.existingBranch && !v.branch.trim()) return t("브랜치 이름을 입력하세요");
      if (!v.path.startsWith("/")) return t("절대 경로를 입력하세요");
      return null;
    },
  });
  if (!values) return null;
  const branch = opts.existingBranch ? null : values.branch.trim();
  const base = opts.existingBranch ?? opts.base ?? null;
  const res = await run(t("워크트리 만들기"), () => api.worktreeAdd(repoPath, values.path.trim(), branch, base));
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
  if (wt.isMain) return st().toast("error", t("메인 워크트리는 지울 수 없습니다"));
  if (!wt.exists) {
    // 폴더가 이미 없으면 등록만 정리한다
    const ok = await st().ask({
      title: t("사라진 워크트리 정리"),
      body: t("{path}\n폴더가 없습니다. 워크트리 등록을 정리합니다(git worktree prune).", { path: wt.path }),
      confirmLabel: t("정리|워크트리"),
    });
    if (ok) await run(t("워크트리 정리"), () => api.worktreePrune(repoPath));
    return;
  }
  const dirty = wt.exists ? await dirtyCount(wt.path) : 0;
  const agents = agentsIn(wt.path);
  const values = await st().promptForm({
    title: t("워크트리 삭제: {name}", { name: baseName(wt.path) }),
    body:
      t("{path}\n폴더를 지우고 워크트리 등록을 해제합니다. 브랜치 '{branch}' 의 커밋은 남아요.", { path: wt.path, branch: wt.branch ?? t("(브랜치 없음)") }) +
      (dirty ? "\n\n⚠ " + t("커밋하지 않은 변경 {n}개가 있습니다. 지우면 되돌릴 수 없습니다.", { n: dirty }) : "") +
      (agents ? "\n⚠ " + t("이 워크트리에서 에이전트 {n}개가 실행 중입니다.", { n: agents }) : ""),
    fields: [
      ...(dirty ? [{ key: "force", label: t("변경 {n}개를 버리고 삭제", { n: dirty }), value: "false", checkbox: true }] : []),
      ...(wt.branch ? [{ key: "deleteBranch", label: t("브랜치 '{branch}' 도 삭제 (병합된 경우만)", { branch: wt.branch }), value: "false", checkbox: true }] : []),
    ],
    danger: true,
    confirmLabel: t("삭제"),
    validate: (v) => (dirty && v.force !== "true" ? t("변경을 버리는 데 동의해야 삭제할 수 있습니다") : null),
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
      st().toast("error", t("{label} 실패: {error}", { label: t("워크트리 삭제"), error: errorText(e) }));
      afterChange();
      return;
    }
    const go = await st().ask({
      title: t("외부 에이전트가 실행 중"),
      body: t("이 워크트리에서 앱 밖의 에이전트 {n}개가 실행 중입니다. 폴더를 지우면 그 에이전트가 하던 작업이 깨집니다.\n그래도 삭제할까요?", { n: m[1] }),
      danger: true,
      confirmLabel: t("그래도 삭제"),
    });
    if (!go) return;
    res = await run(t("워크트리 삭제"), () => api.worktreeRemove(repoPath, wt.path, force, true));
  }
  if (res !== null) st().toast("success", t("{label} 완료", { label: t("워크트리 삭제") }));
  afterChange();
  if (res !== null && values.deleteBranch === "true" && wt.branch) {
    await run(t("브랜치 '{branch}' 삭제", { branch: wt.branch }), () => api.branchDelete(repoPath, wt.branch!, false));
  }
  if (res !== null && focus === wt.path) st().setFocusWorktree(repoPath);
}

export async function createBranch(worktree: string, start: string, startLabel: string) {
  const values = await st().promptForm({
    title: t("새 브랜치"),
    body: t("{start} 에서 시작합니다.", { start: startLabel }),
    fields: [
      { key: "name", label: t("브랜치 이름"), value: "", placeholder: "feature/..." },
      { key: "checkout", label: t("만든 뒤 지금 워크트리를 이 브랜치로 전환"), value: "false", checkbox: true },
    ],
    confirmLabel: t("만들기"),
    validate: (v) => (v.name.trim() ? null : t("이름을 입력하세요")),
  });
  if (!values) return;
  if (values.checkout === "true") {
    const warn = checkoutWarning(await dirtyCount(worktree), values.name, agentsIn(worktree));
    if (warn && !(await st().ask({ title: t("체크아웃 확인"), body: `⚠ ${warn}`, danger: true, confirmLabel: t("만들고 체크아웃") }))) return;
  }
  await run(t("브랜치 만들기"), () => api.branchCreate(worktree, values.name.trim(), start, values.checkout === "true"));
}

export async function deleteBranch(repoPath: string, ref: GitRef) {
  const ok = await st().ask({
    title: t("브랜치 '{branch}' 삭제", { branch: ref.short }),
    body: t("병합된 브랜치만 지웁니다(git branch -d). 병합되지 않은 커밋이 있으면 Git 이 거부합니다."),
    danger: true,
    confirmLabel: t("삭제"),
  });
  if (!ok) return;
  await run(t("브랜치 삭제"), () => api.branchDelete(repoPath, ref.short, false));
}

/** 현재 브랜치에 target 을 병합 */
export async function merge(worktree: string, current: string | null, target: string) {
  if (!current) return st().toast("error", t("브랜치가 없는 상태에서는 병합할 수 없어요. 먼저 브랜치로 전환하세요."));
  const cmp = await api.compare(worktree, current, target).catch(() => null);
  if (cmp && cmp.behind === 0) return st().toast("info", t("'{target}' 의 커밋이 이미 '{current}' 에 모두 들어 있습니다", { target, current }));
  const warn = checkoutWarning(await dirtyCount(worktree), current, agentsIn(worktree));
  const values = await st().promptForm({
    title: t("{target} → {current} 병합", { target, current }),
    body:
      t("{target} 에만 있는 커밋 {n}개를 {current} 로 가져옵니다.", { target, n: cmp?.behind ?? "?", current }) +
      (cmp?.fastForward ? "\n" + t("지금은 병합 커밋 없이 앞으로 이동만 하면 됩니다.") : "") +
      "\n" +
      t("충돌이 나면 멈추고, 해결한 뒤 계속하거나 중단할 수 있습니다.") +
      (warn ? `\n\n⚠ ${warn}` : ""),
    fields: [
      {
        key: "mode",
        label: t("방식"),
        value: "ff",
        options: [
          { value: "ff", label: t("가능하면 그냥 앞으로 이동 (기본, fast-forward)") },
          { value: "no-ff", label: t("항상 병합 커밋 만들기 (--no-ff)") },
          { value: "ff-only", label: t("앞으로 이동만, 안 되면 취소 (--ff-only)") },
        ],
      },
    ],
    danger: !!warn,
    confirmLabel: t("병합"),
  });
  if (!values) return;
  const r = await run(t("병합"), () => api.merge(worktree, target, values.mode as "ff" | "no-ff" | "ff-only"));
  if (r?.conflict) st().toast("error", t("충돌이 생겼습니다. Git 패널 위쪽에서 파일별로 해결한 뒤 '계속'을 누르세요."));
}

/** 현재 브랜치를 onto 위로 rebase */
export async function rebase(worktree: string, current: string | null, onto: string, upstream: string | null) {
  if (!current) return st().toast("error", t("브랜치가 없는 상태에서는 리베이스할 수 없어요."));
  const cmp = await api.compare(worktree, current, onto).catch(() => null);
  if (cmp && cmp.behind === 0) return st().toast("info", t("'{current}' 은(는) 이미 '{onto}' 위에 있습니다", { current, onto }));
  // 이미 push 한 커밋을 다시 쓰는지
  const pushed = upstream ? await api.compare(worktree, current, upstream).catch(() => null) : null;
  const rewritesPushed = !!upstream && !!cmp && (pushed ? pushed.ahead < cmp.ahead : true);
  const warn = checkoutWarning(await dirtyCount(worktree), current, agentsIn(worktree));
  const ok = await st().ask({
    title: t("{current} 를 {onto} 위로 리베이스", { current, onto }),
    body:
      t("{current} 에만 있는 커밋 {ahead}개를 {onto} 의 최신 커밋({behind}개 앞) 위에 다시 씁니다. 커밋 해시가 바뀝니다.", {
        current,
        ahead: cmp?.ahead ?? "?",
        onto,
        behind: cmp?.behind ?? "?",
      }) +
      (rewritesPushed
        ? "\n\n⚠ " + t("이미 {upstream} 에 push 한 커밋도 다시 쓰게 됩니다. 이후 push 에는 강제 푸시가 필요하고, 다른 사람의 작업과 충돌할 수 있습니다.", { upstream })
        : "") +
      (warn ? `\n\n⚠ ${warn}` : ""),
    danger: rewritesPushed || !!warn,
    confirmLabel: t("리베이스"),
  });
  if (!ok) return;
  const r = await run(t("리베이스"), () => api.rebase(worktree, onto));
  if (r?.conflict) st().toast("error", t("리베이스 중 충돌이 생겼어요. Git 패널 위쪽에서 해결한 뒤 '계속', 건너뛰려면 '건너뛰기', 원래대로 하려면 '중단'."));
}
