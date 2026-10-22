// 내 수정 워크트리: AI 가 일하는 워크트리는 그대로 두고 옆 폴더의 edit/<AI 브랜치> 에서 고친 뒤, 커밋해서 AI 브랜치에 합친다.
import { api, errorText } from "../../api";
import { merge } from "../../gitActions";
import { t } from "../../i18n";
import { baseName } from "../../logic";
import { useStore } from "../../store";

export const EDIT_PREFIX = "edit/";

export const isEditBranch = (b: string | null | undefined): b is string => !!b && b.startsWith(EDIT_PREFIX) && b.length > EDIT_PREFIX.length;

/** edit/feature/x → feature/x */
export const agentBranchOf = (editBranch: string) => editBranch.slice(EDIT_PREFIX.length);

const st = () => useStore.getState();

function worktreeOf(path: string) {
  return st()
    .repos.flatMap((r) => r.worktrees)
    .find((w) => w.path === path);
}

/** AI 가 일하는 워크트리 대신 내 수정 워크트리에서 이 파일을 연다(없으면 만든다). */
export async function openInEditWorktree(worktree: string, rel: string) {
  const branch = worktreeOf(worktree)?.branch;
  if (!branch) return st().toast("error", t("브랜치가 없는 상태(detached)의 워크트리에서는 내 수정 워크트리를 만들 수 없어요"));
  const ok = await st().ask({
    title: t("내 수정 워크트리에서 고칠까요?"),
    body: t(
      "AI 가 일하는 {worktree} ({branch}) 는 그대로 두고, 옆 폴더에 '{edit}' 브랜치로 내 수정 워크트리를 열어요(이미 있으면 그걸 써요).\n\nAI 가 아직 커밋하지 않은 변경은 내 수정 워크트리에 없어요. 다 고치면 커밋한 뒤 'AI 브랜치에 합치기'로 합쳐요.",
      { worktree: baseName(worktree), branch, edit: EDIT_PREFIX + branch },
    ),
    confirmLabel: t("열기"),
  });
  if (!ok) return;
  try {
    const path = await api.editWorktree(worktree);
    await st().refreshRepos();
    st().setFocusWorktree(path);
    st().openViewer({ kind: "file", rel, mode: "preview" });
    st().toast("success", t("내 수정 워크트리를 열었어요: {path}", { path: baseName(path) }));
  } catch (e) {
    st().toast("error", t("내 수정 워크트리를 열지 못했어요: {error}", { error: errorText(e) }));
  }
}

/** 내 수정 워크트리(edit/B)의 커밋을 AI 브랜치 B 에 합친다. 커밋하지 않은 변경이 있으면 먼저 커밋하라고 알린다. */
export async function mergeIntoAgent(editWorktree: string) {
  const edit = worktreeOf(editWorktree)?.branch;
  if (!isEditBranch(edit)) return;
  const target = agentBranchOf(edit);
  const status = await api.status(editWorktree).catch(() => null);
  const dirty = status?.entries.filter((e) => e.kind !== "ignored").length ?? 0;
  if (dirty > 0) return st().toast("error", t("커밋하지 않은 수정이 {n}개 있어요. Git 패널 → 변경 사항에서 먼저 커밋하세요.", { n: dirty }));
  const agent = st()
    .repos.flatMap((r) => r.worktrees)
    .find((w) => w.branch === target && w.exists);
  if (!agent) return st().toast("error", t("'{branch}' 브랜치를 쓰는 워크트리가 없어 합칠 곳이 없어요", { branch: target }));
  await merge(agent.path, target, edit);
}
