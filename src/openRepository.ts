import { open } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "./api";
import { t } from "./i18n";
import { useStore } from "./store";

export async function openRepository() {
  try {
    const dir = await open({ directory: true, multiple: false, title: t("저장소로 쓸 폴더 선택") });
    if (typeof dir !== "string") return;
    const repo = await addOrInit(dir);
    if (!repo) return;
    await useStore.getState().refreshRepos();
    const fresh = useStore.getState().repos.find((r) => r.id === repo.id);
    const target = fresh?.worktrees.find((w) => w.path === dir && w.exists && !w.bare);
    if (target) useStore.getState().setFocusWorktree(target.path);
    else useStore.getState().openRepoTab(repo.id);
    useStore.getState().toast("success", t("저장소를 추가했습니다: {name}", { name: repo.name }));
  } catch (e) { useStore.getState().toast("error", errorText(e)); }
}

/** Git 저장소면 그대로 추가하고, 아니면 이 폴더에서 Git 을 시작할지(git init) 물어본다. */
async function addOrInit(dir: string) {
  const probe = await api.repoProbe(dir);
  if (probe.isRepo) return api.repoAdd(dir);
  const st = useStore.getState();
  if (!probe.canInit) {
    st.toast("error", t("Git 저장소가 아닙니다: {reason}", { reason: probe.reason ?? dir }));
    return null;
  }
  const ok = await st.ask({
    title: t("Git 저장소가 아닌 폴더예요"),
    body: t("{path}\n\n이 폴더에서 Git 을 시작할까요? (git init)\n파일은 그대로 두고 .git 폴더만 만들어요. 커밋은 하지 않으니 Git 패널에서 담을 파일을 고른 뒤 첫 커밋을 하세요.", { path: dir }),
    confirmLabel: t("Git 시작하고 추가"),
  });
  return ok ? api.repoInit(dir) : null;
}
