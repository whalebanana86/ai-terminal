import { open } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "./api";
import { t } from "./i18n";
import { useStore } from "./store";

export async function openRepository() {
  try {
    const dir = await open({ directory: true, multiple: false, title: t("Git 저장소 폴더 선택") });
    if (typeof dir !== "string") return;
    const repo = await api.repoAdd(dir);
    await useStore.getState().refreshRepos();
    const fresh = useStore.getState().repos.find((r) => r.id === repo.id);
    const target = fresh?.worktrees.find((w) => w.path === dir && w.exists && !w.bare);
    if (target) useStore.getState().setFocusWorktree(target.path);
    else useStore.getState().openRepoTab(repo.id);
    useStore.getState().toast("success", t("저장소를 추가했습니다: {name}", { name: repo.name }));
  } catch (e) { useStore.getState().toast("error", errorText(e)); }
}
