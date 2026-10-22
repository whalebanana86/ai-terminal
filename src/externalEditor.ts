// 외부 편집기로 열기. 고른 편집기는 이 맥의 화면 설정(localStorage)에 둔다. "auto" = 설치된 첫 편집기(VS Code·Cursor·Zed…), 없으면 맥 기본 글 편집기.
import { api, errorText } from "./api";
import { t } from "./i18n";
import { useStore } from "./store";

const KEY = "aiterm.externalEditor";

export function getExternalEditor(): string {
  try {
    return localStorage.getItem(KEY) || "auto";
  } catch {
    return "auto";
  }
}

export function setExternalEditor(id: string) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* 저장 못 하면 이번만 */
  }
}

export async function openExternal(worktree: string, rel: string) {
  try {
    await api.openInEditor(worktree, rel, getExternalEditor());
  } catch (e) {
    useStore.getState().toast("error", t("외부 편집기로 열지 못했어요: {error}", { error: errorText(e) }));
  }
}
