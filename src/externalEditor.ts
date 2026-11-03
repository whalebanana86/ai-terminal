// 외부 편집기·브라우저로 열기. 고른 편집기·브라우저는 이 맥의 화면 설정(localStorage)에 둔다. "auto" = 설치된 첫 편집기(VS Code·Cursor·Zed…), 없으면 맥 기본 글 편집기.
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

/** 맥에서 그 파일 종류의 기본 앱(미리보기 등)으로 열기. 백엔드가 PDF 만 받는다. */
export async function openInDefaultApp(worktree: string, rel: string) {
  try {
    await api.openInEditor(worktree, rel, "default");
  } catch (e) {
    useStore.getState().toast("error", t("기본 앱으로 열지 못했어요: {error}", { error: errorText(e) }));
  }
}

const BROWSER_KEY = "aiterm.browser";

/** md 를 열 브라우저. "default" = 맥 기본 브라우저 */
export function getBrowser(): string {
  try {
    return localStorage.getItem(BROWSER_KEY) || "default";
  } catch {
    return "default";
  }
}

export function setBrowser(id: string) {
  try {
    localStorage.setItem(BROWSER_KEY, id);
  } catch {
    /* 저장 못 하면 이번만 */
  }
}

/** md 를 꼴 갖춘 문서로 브라우저에서 연다(크롬이 md 의 한글을 깨뜨리지 않게 UTF-8 HTML 로 바꿔서). */
export async function openMarkdownInBrowser(worktree: string, rel: string) {
  try {
    const [{ renderMarkdown }, file] = await Promise.all([import("./markdown"), api.fsRead(worktree, rel)]);
    if (file.text === null) throw new Error(t("바이너리 파일"));
    await api.mdOpenInBrowser(worktree, rel, renderMarkdown(file.text, { app: false, worktree, rel }), getBrowser());
  } catch (e) {
    useStore.getState().toast("error", t("브라우저로 열지 못했어요: {error}", { error: errorText(e) }));
  }
}

/** md 미리보기의 바깥 링크(http·https 는 고른 브라우저, mailto 는 메일 앱) */
export async function openLink(url: string) {
  try {
    await api.openUrl(url, getBrowser());
  } catch (e) {
    useStore.getState().toast("error", t("링크를 열지 못했어요: {error}", { error: errorText(e) }));
  }
}
