// 저장하지 않은 편집 내용. 다른 파일·탭으로 옮겨도 남아 있다가 돌아오면 이어서 보여 준다(앱을 끄면 사라짐, 디스크에 쓰지 않음).
import { useSyncExternalStore } from "react";
import type { Text } from "@codemirror/state";
import { api, errorText } from "../../api";
import { t } from "../../i18n";

export interface Draft {
  /** 고친 내용(CodeMirror 문서, 바꿀 때마다 새 값이라 그대로 들고 있어도 된다) */
  doc: Text;
  /** 불러올 때의 지문·줄바꿈 */
  hash: string;
  crlf: boolean;
  bom: boolean;
}

const drafts = new Map<string, Draft>();
const listeners = new Set<() => void>();
let version = 0;

export const draftKey = (worktree: string, rel: string) => `${worktree}\u0000${rel}`;

export function getDraft(worktree: string, rel: string): Draft | undefined {
  return drafts.get(draftKey(worktree, rel));
}

export function setDraft(worktree: string, rel: string, d: Draft) {
  const k = draftKey(worktree, rel);
  const had = drafts.has(k);
  drafts.set(k, d);
  // 글자마다 알리지 않고, 있고 없음이 바뀔 때만(탭의 • 표시)
  if (!had) bump();
}

export function dropDraft(worktree: string, rel: string) {
  if (drafts.delete(draftKey(worktree, rel))) bump();
}

/** 남아 있는 수정을 저장한다(편집 화면을 열지 않고). 성공이면 null, 아니면 이유 */
export async function saveDraft(worktree: string, rel: string): Promise<string | null> {
  const d = getDraft(worktree, rel);
  if (!d) return null;
  try {
    const r = await api.saveFile({ worktree, rel, text: d.doc.toString(), crlf: d.crlf, bom: d.bom, expected: d.hash, force: false });
    if (!r.saved) return t("그사이 밖에서 바뀜");
    dropDraft(worktree, rel);
    return null;
  } catch (e) {
    return errorText(e);
  }
}

/** 저장하지 않은 편집이 남아 있는 파일 수 */
export function draftCount(): number {
  return drafts.size;
}

function bump() {
  version++;
  listeners.forEach((f) => f());
}

function subscribe(f: () => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function useHasDraft(worktree: string, rel: string): boolean {
  useSyncExternalStore(subscribe, () => version);
  return drafts.has(draftKey(worktree, rel));
}
