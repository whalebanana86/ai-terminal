import { getCurrentWebview } from "@tauri-apps/api/webview";

/**
 * 파일·폴더를 창에 끌어다 놓기.
 * - 터미널 위: 경로를 셸 방식으로 이스케이프해 붙여넣기(iTerm·터미널 앱과 같게). Claude Code 는 이미지 경로를 그림으로 알아본다.
 * - 글 입력칸(채팅·첫 지시 등) 위: 커서 자리에 경로를 끼워 넣는다.
 * - 파일 트리의 폴더 줄(빈 곳 = 워크트리 맨 위) 위: Finder 에서 온 것은 복사, 트리에서 끌어온 것은 이동.
 * 끄는 동안에는 놓을 곳에 테두리를 보여 준다.
 *
 * 트리에서 끄는 것도 맥 네이티브 드래그(tauri-plugin-drag, treeDrag.ts)라서 Finder·다른 앱에 놓으면 실제 파일이 넘어간다.
 * 그 드래그가 우리 창 위로 돌아오면 Finder 에서 온 것과 똑같이 wry 의 파일 드롭(onDragDropEvent)으로 들어오므로,
 * 시작할 때 경로를 기억해 두고(outgoing) 우리가 시작한 것인지 가려 '경로 넣기·이동·복사' 를 이 한 곳에서 정한다.
 * (웹뷰의 HTML 끌기 draggable 은 dragDropEnabled 가 켜져 있으면 wry 가 드롭을 가로채 쓸 수 없다.)
 */

/** 터미널에 붙일 때: 공백·따옴표 등 셸 특수문자 앞에 \ (터미널 앱이 하는 방식) */
export function shellEscape(path: string): string {
  return path.replace(/[ \t!"#$&'()*;<>?[\\\]`{|}~]/g, "\\$&");
}

/** 글 입력칸에 넣을 때: 사람이 읽기 좋게, 공백이 있으면 따옴표로 */
export function plainPath(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

/** Claude Code 가 붙여넣은 경로를 그림으로 알아보는 형식 */
export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(path);
}

/**
 * 에이전트에게 줄 경로. 그 에이전트의 작업 폴더(cwd) 안이면 상대 경로로 줄인다:
 * 에이전트는 작업 폴더를 기준으로 경로를 읽으므로 뜻이 같고, 길고 사람마다 다른 홈 경로가 대화에 남지 않는다.
 * 그림은 Finder 에서 끌어온 것과 같게 절대 경로로 둔다(Claude Code 가 그림으로 알아보는 것이 확인된 꼴).
 * 작업 폴더 자체나 밖의 경로도 절대 경로.
 */
export function pathForAgent(abs: string, cwd: string | null | undefined): string {
  if (!cwd || isImagePath(abs)) return abs;
  const base = cwd.replace(/\/+$/, "");
  return abs.startsWith(`${base}/`) && abs.length > base.length + 1 ? abs.slice(base.length + 1) : abs;
}

/** "a/b/c.ts" → "a/b", 맨 위면 "" */
export function parentRel(rel: string): string {
  const i = rel.replace(/\/+$/, "").lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

/** 놓을 곳(화면 요소 없이). 트리의 dir 은 워크트리 기준 폴더("" = 맨 위) */
export type DropSpot =
  | { kind: "terminal"; execId: string }
  | { kind: "input"; cwd: string | null }
  | { kind: "tree"; worktree: string; dir: string };

export type DropTarget =
  | { kind: "terminal"; el: HTMLElement; execId: string }
  | { kind: "input"; el: HTMLTextAreaElement | HTMLInputElement; cwd: string | null }
  | { kind: "tree"; el: HTMLElement; worktree: string; dir: string };

/** 트리에서 시작한 드래그: 어느 워크트리의 무엇(rels)을, 실제 경로(paths)로 */
export interface Outgoing {
  worktree: string;
  rels: string[];
  paths: string[];
}

/** 화면 좌표(CSS px) 아래에서 놓을 곳을 찾는다 */
export function dropTargetAt(x: number, y: number): DropTarget | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return null;
  const term = el.closest<HTMLElement>(".term-host");
  if (term?.dataset.exec) return { kind: "terminal", el: term, execId: term.dataset.exec };
  const input = el.closest<HTMLTextAreaElement | HTMLInputElement>("textarea, input");
  if (input && !input.disabled && !input.readOnly && (input.tagName === "TEXTAREA" || ["text", "search", ""].includes((input as HTMLInputElement).type))) {
    // 채팅 입력칸 등은 data-cwd 로 그 에이전트의 작업 폴더를 알려 준다(상대 경로로 줄이려고)
    return { kind: "input", el: input, cwd: input.closest<HTMLElement>("[data-cwd]")?.dataset.cwd ?? null };
  }
  const tree = el.closest<HTMLElement>("[data-drop-tree]");
  if (tree?.dataset.dropTree) {
    // 폴더 줄이면 그 폴더, 파일 줄이면 그 파일이 든 폴더, 빈 곳이면 워크트리 맨 위
    const row = el.closest<HTMLElement>(".tree-row");
    const dir = row?.dataset.dir ?? (row?.dataset.rel ? parentRel(row.dataset.rel) : "");
    const dirRow = dir ? tree.querySelector<HTMLElement>(`.tree-row[data-dir="${CSS.escape(dir)}"]`) : null;
    // 강조: 폴더 줄 → 그 줄, 맨 위 → 트리 전체, 폴더 줄이 안 보이는 목록(바뀐 파일만) → 가리킨 줄
    return { kind: "tree", el: dirRow ?? (dir && row ? row : tree), worktree: tree.dataset.dropTree, dir };
  }
  return null;
}

/** rel 을 dir 로 옮기는 것이 뜻이 있는지: 자기 자신·이미 든 폴더는 아니다(자기 하위는 백엔드가 이유와 함께 거부) */
function movable(rel: string, dir: string): boolean {
  return rel !== dir && parentRel(rel) !== dir;
}

/** 끄는 동안 이곳에 테두리를 보일지 */
export function acceptsDrop(spot: DropSpot, mine: Outgoing | null): boolean {
  if (spot.kind !== "tree" || !mine || mine.worktree !== spot.worktree) return true;
  return mine.rels.some((rel) => movable(rel, spot.dir) && !spot.dir.startsWith(`${rel}/`));
}

export type DropPlan =
  | { kind: "paste"; execId: string; text: string }
  | { kind: "insert"; text: string }
  | { kind: "move"; worktree: string; dir: string; rels: string[] }
  | { kind: "copy"; worktree: string; dir: string; paths: string[] }
  /** 우리가 시작한 드래그를 제자리·놓을 수 없는 곳에 놓음: 조용히 둔다 */
  | { kind: "ignore" }
  /** 밖에서 온 파일을 놓을 수 없는 곳에 놓음: 안내 */
  | { kind: "miss" };

/**
 * 놓았을 때 할 일. mine 은 트리에서 시작한 드래그(없으면 Finder 등 밖에서 온 것).
 * 터미널·입력칸 → 경로 넣기, 같은 워크트리 트리 폴더 → 이동, 그 밖의 트리 폴더 → 복사.
 */
export function planDrop(spot: DropSpot | null, paths: string[], mine: Outgoing | null, execCwd: (execId: string) => string | null): DropPlan {
  if (!paths.length) return { kind: "ignore" };
  if (!spot) return mine ? { kind: "ignore" } : { kind: "miss" };
  switch (spot.kind) {
    case "terminal": {
      const cwd = execCwd(spot.execId);
      // 경로 뒤에 빈칸 하나(터미널 앱과 같음) — 이어서 글을 쓰기 쉽게
      return { kind: "paste", execId: spot.execId, text: paths.map((p) => shellEscape(pathForAgent(p, cwd))).join(" ") + " " };
    }
    case "input":
      return { kind: "insert", text: paths.map((p) => plainPath(pathForAgent(p, spot.cwd))).join(" ") };
    case "tree": {
      if (mine && mine.worktree === spot.worktree) {
        const rels = mine.rels.filter((rel) => movable(rel, spot.dir));
        return rels.length ? { kind: "move", worktree: spot.worktree, dir: spot.dir, rels } : { kind: "ignore" };
      }
      return { kind: "copy", worktree: spot.worktree, dir: spot.dir, paths };
    }
  }
}

/** 이름만 비교한다: 맥은 한글 이름을 자모가 나뉜 꼴(NFD)로 돌려줄 수 있어 NFC 로 맞춘다 */
function names(paths: string[]): string {
  return paths
    .map((p) => (p.replace(/\/+$/, "").split("/").pop() ?? "").normalize("NFC"))
    .sort()
    .join("\0");
}

/** 드롭 이벤트의 경로가 우리가 시작한 드래그의 것인지. 경로를 못 읽어 왔으면(빈 목록) 끌던 중인 우리 것으로 본다 */
export function sameDrag(eventPaths: string[], mine: Outgoing): boolean {
  return !eventPaths.length || names(eventPaths) === names(mine.paths);
}

// ── 트리에서 시작한 드래그 기억 ──
// 네이티브 드래그가 끝났다는 알림(플러그인)과 창 안 드롭 이벤트(wry) 중 무엇이 먼저 올지 모르므로 끝난 뒤에도 잠깐 기억한다.
const AFTER_END_MS = 1500;
let outgoing: (Outgoing & { endedAt: number | null }) | null = null;

export function beginOutgoing(o: Outgoing) {
  outgoing = { ...o, endedAt: null };
}

/** 드래그가 끝남. now 면 바로 잊는다(시작하지 못한 경우) */
export function endOutgoing(now = false) {
  const o = outgoing;
  if (!o) return;
  if (now) {
    outgoing = null;
    return;
  }
  o.endedAt = Date.now();
  setTimeout(() => {
    if (outgoing === o) outgoing = null;
  }, AFTER_END_MS);
}

/** 트리에서 끄는 중인지(새 드래그를 겹쳐 시작하지 않게) */
export function outgoingActive(): boolean {
  return !!outgoing && outgoing.endedAt === null;
}

function currentOutgoing(eventPaths: string[]): Outgoing | null {
  const o = outgoing;
  if (!o || (o.endedAt !== null && Date.now() - o.endedAt > AFTER_END_MS)) return null;
  return sameDrag(eventPaths, o) ? o : null;
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

export interface DropHandlers {
  /** 실행 id 의 터미널에 붙여넣는다. 터미널이 없으면 false */
  paste: (execId: string, text: string) => boolean;
  /** 실행 id 의 작업 폴더 */
  execCwd: (execId: string) => string | null;
  /** 트리 폴더에 놓음: 복사·이동 */
  transfer: (plan: Extract<DropPlan, { kind: "copy" | "move" }>) => void;
  /** 밖에서 온 파일을 놓을 수 없는 곳에 놓음 */
  onMiss: () => void;
}

/** 앱 전체에 한 번 붙인다. */
export function attachFileDrop(h: DropHandlers): () => void {
  let marked: HTMLElement | null = null;
  const mark = (el: HTMLElement | null) => {
    if (marked === el) return;
    marked?.classList.remove("drop-target");
    marked = el;
    marked?.classList.add("drop-target");
  };
  // 맥에서는 wry 가 창 안 위치를 이미 포인트(= CSS px) 로 준다. Tauri 는 이름만 PhysicalPosition 으로 감싸고 바꾸지 않으므로
  // 여기서 화면 배율로 나누면 절반 자리를 찾게 된다(그래서 터미널에 놓아도 경로가 안 들어갔다). 다른 OS 는 실제 물리 픽셀.
  const scale = /Mac/i.test(navigator.userAgent) ? 1 : window.devicePixelRatio;
  const at = (p: { x: number; y: number }) => dropTargetAt(p.x / scale, p.y / scale);
  // 지금 창 위에 있는 드래그가 트리에서 시작한 것인지(over 이벤트에는 경로가 없어 enter 때 정해 둔다)
  let mine: Outgoing | null = null;
  // 새로 누르면 앞의 네이티브 드래그는 끝난 것이다(끄는 동안에는 맥이 마우스를 맡아 웹뷰에 누름이 오지 않는다).
  // 끝났다는 알림을 놓쳤더라도 '우리 드래그' 로 남아 Finder 에서 온 것을 잘못 알아보지 않게 한다.
  const onDown = () => {
    if (outgoingActive()) endOutgoing();
  };
  window.addEventListener("mousedown", onDown, true);
  let off: (() => void) | null = null;
  let disposed = false;
  void getCurrentWebview()
    .onDragDropEvent((e) => {
      const d = e.payload;
      if (d.type === "leave") return mark(null);
      if (d.type === "enter") mine = currentOutgoing(d.paths);
      const t = at(d.position);
      if (d.type !== "drop") return mark(t && acceptsDrop(t, mine) ? t.el : null);
      mark(null);
      const from = currentOutgoing(d.paths);
      // 우리 드래그는 시작할 때 기억한 경로를 쓴다(wry 가 읽어 온 경로는 꼴이 다를 수 있다)
      if (from) endOutgoing(true);
      const plan = planDrop(t, from ? from.paths : d.paths, from, h.execCwd);
      switch (plan.kind) {
        case "paste":
          if (!h.paste(plan.execId, plan.text)) h.onMiss();
          return;
        case "insert":
          if (t?.kind === "input") insertIntoInput(t.el, plan.text);
          return;
        case "move":
        case "copy":
          return h.transfer(plan);
        case "miss":
          return h.onMiss();
      }
    })
    .then((un) => {
      if (disposed) un();
      else off = un;
    });
  return () => {
    disposed = true;
    window.removeEventListener("mousedown", onDown, true);
    mark(null);
    off?.();
  };
}
