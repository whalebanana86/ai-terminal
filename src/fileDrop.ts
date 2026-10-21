import { getCurrentWebview } from "@tauri-apps/api/webview";

/**
 * 파일(이미지 등)을 창에 끌어다 놓으면 경로를 넣는다.
 * - 터미널 위: 경로를 셸 방식으로 이스케이프해 붙여넣기(iTerm·터미널 앱과 같게). Claude Code 는 이미지 경로를 그림으로 알아본다.
 * - 글 입력칸(채팅·첫 지시 등) 위: 커서 자리에 경로를 끼워 넣는다.
 * 끄는 동안에는 놓을 곳에 테두리를 보여 준다.
 */

/** 터미널에 붙일 때: 공백·따옴표 등 셸 특수문자 앞에 \ (터미널 앱이 하는 방식) */
export function shellEscape(path: string): string {
  return path.replace(/[ \t!"#$&'()*;<>?[\\\]`{|}~]/g, "\\$&");
}

/** 글 입력칸에 넣을 때: 사람이 읽기 좋게, 공백이 있으면 따옴표로 */
export function plainPath(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

export type DropTarget = { kind: "terminal"; el: HTMLElement; execId: string } | { kind: "input"; el: HTMLTextAreaElement | HTMLInputElement };

/** 화면 좌표(CSS px) 아래에서 놓을 곳을 찾는다 */
export function dropTargetAt(x: number, y: number): DropTarget | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return null;
  const term = el.closest<HTMLElement>(".term-host");
  if (term?.dataset.exec) return { kind: "terminal", el: term, execId: term.dataset.exec };
  const input = el.closest<HTMLTextAreaElement | HTMLInputElement>("textarea, input");
  if (input && !input.disabled && !input.readOnly && (input.tagName === "TEXTAREA" || ["text", "search", ""].includes((input as HTMLInputElement).type))) {
    return { kind: "input", el: input };
  }
  return null;
}

/** 입력칸의 커서 자리에 글을 끼워 넣고 React 에도 알린다 */
export function insertIntoInput(el: HTMLTextAreaElement | HTMLInputElement, text: string) {
  const v = el.value;
  const start = el.selectionStart ?? v.length;
  const end = el.selectionEnd ?? v.length;
  const before = v.slice(0, start);
  const after = v.slice(end);
  const piece = (before && !/\s$/.test(before) ? " " : "") + text + (after && !/^\s/.test(after) ? " " : "");
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, before + piece + after);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  const caret = (before + piece).length;
  el.setSelectionRange(caret, caret);
}

/** 앱 전체에 한 번 붙인다. paste 는 실행 id 의 터미널에 붙여넣는 함수. */
export function attachFileDrop(paste: (execId: string, text: string) => boolean, onMiss: () => void): () => void {
  let marked: HTMLElement | null = null;
  const mark = (el: HTMLElement | null) => {
    if (marked === el) return;
    marked?.classList.remove("drop-target");
    marked = el;
    marked?.classList.add("drop-target");
  };
  const at = (p: { x: number; y: number }) => dropTargetAt(p.x / window.devicePixelRatio, p.y / window.devicePixelRatio);
  let off: (() => void) | null = null;
  let disposed = false;
  void getCurrentWebview()
    .onDragDropEvent((e) => {
      const d = e.payload;
      if (d.type === "leave") return mark(null);
      const t = at(d.position);
      if (d.type !== "drop") return mark(t?.el ?? null);
      mark(null);
      if (!d.paths.length) return;
      if (t?.kind === "terminal") {
        // 경로 뒤에 빈칸 하나(터미널 앱과 같음) — 이어서 글을 쓰기 쉽게
        if (paste(t.execId, d.paths.map(shellEscape).join(" ") + " ")) return;
      } else if (t?.kind === "input") {
        return insertIntoInput(t.el, d.paths.map(plainPath).join(" "));
      }
      onMiss();
    })
    .then((un) => {
      if (disposed) un();
      else off = un;
    });
  return () => {
    disposed = true;
    mark(null);
    off?.();
  };
}
