// 탭 끌어 옮기기(맨 위 저장소 탭·가운데 파일 탭).
// 웹뷰의 HTML 끌어놓기(draggable)는 Tauri 파일 드롭(dragDropEnabled)이 가로채 쓸 수 없어서 누름·움직임·놓기 마우스 이벤트로 직접 한다.
// 옮길 수 있는 탭 요소에는 data-drag-id 를 붙이고, 그 순서(왼쪽 → 오른쪽)가 화면의 탭 순서다.
import { useRef, useState, type RefObject } from "react";

/** 이만큼 움직여야 끌기로 본다(그 전에는 그냥 누르기·닫기) */
export const DRAG_START_PX = 5;

/** id 를 target 앞(after 면 뒤)으로 옮긴 목록. 옮길 것이 없으면 같은 목록을 그대로 돌려준다 */
export function moveNear<T>(list: T[], key: (x: T) => string, id: string, target: string, after: boolean): T[] {
  if (id === target) return list;
  const item = list.find((x) => key(x) === id);
  if (item === undefined) return list;
  const rest = list.filter((x) => key(x) !== id);
  const i = rest.findIndex((x) => key(x) === target);
  if (i < 0) return list;
  rest.splice(after ? i + 1 : i, 0, item);
  return rest;
}

/** 포인터 x 가 들어갈 자리(0 … 탭 수): 가운데가 x 보다 왼쪽에 있는 탭 수 */
export function slotAt(x: number, rects: { left: number; width: number }[]): number {
  return rects.filter((r) => r.left + r.width / 2 < x).length;
}

/** 자리 slot 에 놓으면 어디로 옮길지. 제자리(자기 바로 앞·뒤)면 null */
export function slotTarget(ids: string[], id: string, slot: number): { target: string; after: boolean } | null {
  const i = ids.indexOf(id);
  if (i < 0 || slot === i || slot === i + 1) return null;
  return slot < ids.length ? { target: ids[slot], after: false } : { target: ids[ids.length - 1], after: true };
}

export interface DragItem {
  id: string;
  left: number;
  width: number;
}

/** 끄는 동안 화면: 끄는 탭과 놓일 자리(null = 제자리라 막대 없음) */
export interface DragView {
  id: string;
  slot: number | null;
}

/** 탭에 붙일 끌기 표시(앞에 빈칸 포함): 끄는 탭은 흐리게, 놓일 자리에 막대 */
export function dragClass(view: DragView | null, ids: string[], id: string): string {
  if (!view) return "";
  const i = ids.indexOf(id);
  let c = view.id === id ? " drag-src" : "";
  if (view.slot !== null && view.slot === i) c += " drop-before";
  if (view.slot !== null && view.slot === ids.length && i === ids.length - 1) c += " drop-after";
  return c;
}

/**
 * 끌기 하나의 진행. 창 이벤트는 부르는 쪽(useTabDrag)이 넘겨 준다(위치만 받으므로 화면 없이 시험할 수 있다).
 * idle(아직 누르기) → drag(문턱을 넘음) → 놓기 또는 cancelled(Esc·창 벗어남).
 * drop 은 끌기였는지 돌려준다: 끌기였으면(그만둔 것도) 뒤따르는 누르기(click)를 막아야 한다.
 */
export function createTabDrag(o: {
  id: string;
  x: number;
  y: number;
  items: () => DragItem[];
  onView: (v: DragView | null) => void;
  onMove: (id: string, target: string, after: boolean) => void;
}) {
  let state: "idle" | "drag" | "cancelled" = "idle";
  const place = (x: number) => {
    const items = o.items();
    const slot = slotAt(x, items);
    return { slot, target: slotTarget(items.map((i) => i.id), o.id, slot) };
  };
  return {
    get state() {
      return state;
    },
    move(x: number, y: number) {
      if (state === "cancelled") return;
      if (state === "idle" && Math.hypot(x - o.x, y - o.y) < DRAG_START_PX) return;
      state = "drag";
      const p = place(x);
      o.onView({ id: o.id, slot: p.target ? p.slot : null });
    },
    cancel() {
      if (state === "drag") state = "cancelled";
      o.onView(null);
    },
    drop(x: number): boolean {
      if (state === "drag") {
        const t = place(x).target;
        if (t) o.onMove(o.id, t.target, t.after);
      }
      o.onView(null);
      return state !== "idle";
    },
  };
}

/**
 * 탭 목록(ref = data-drag-id 탭들을 담은 요소)에 끌어 옮기기를 붙인다.
 * start 는 탭의 onMouseDown, guardClick 은 목록의 onClickCapture 에. view 로 dragClass 를 그린다.
 */
export function useTabDrag(ref: RefObject<HTMLElement | null>, onMove: (id: string, target: string, after: boolean) => void) {
  const [view, setView] = useState<DragView | null>(null);
  const justDragged = useRef(false);
  const items = (): DragItem[] =>
    [...(ref.current?.querySelectorAll<HTMLElement>("[data-drag-id]") ?? [])].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.dragId ?? "", left: r.left, width: r.width };
    });
  const show = (v: DragView | null) => {
    // 끄는 동안 어디서나 잡은 손 모양, 글자 골라지지 않게
    document.body.classList.toggle("tab-dragging", !!v);
    setView(v);
  };
  const start = (e: React.MouseEvent, id: string) => {
    // 왼쪽 단추만(맥에서 ctrl+누르기는 오른쪽 클릭, 가운데 단추는 탭 닫기)
    if (e.button !== 0 || e.ctrlKey || e.metaKey) return;
    const d = createTabDrag({ id, x: e.clientX, y: e.clientY, items, onView: show, onMove });
    const finish = (dragged: boolean) => {
      window.removeEventListener("mousemove", onMoveEv, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      if (!dragged) return;
      // 놓은 바로 뒤에 오는 click 하나만 막는다
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
    };
    const onMoveEv = (m: MouseEvent) => {
      // 창 밖에서 단추를 뗐으면 mouseup 이 오지 않는다
      if (!(m.buttons & 1)) {
        d.cancel();
        return finish(d.drop(m.clientX));
      }
      d.move(m.clientX, m.clientY);
      if (d.state !== "idle") m.preventDefault();
    };
    const onUp = (u: MouseEvent) => finish(d.drop(u.clientX));
    const onKey = (k: KeyboardEvent) => {
      if (k.key !== "Escape" || d.state !== "drag") return;
      k.preventDefault();
      k.stopPropagation();
      // 단추를 뗄 때까지 기다렸다가 그 click 을 막는다
      d.cancel();
    };
    const onBlur = () => {
      d.cancel();
      finish(d.drop(0));
    };
    window.addEventListener("mousemove", onMoveEv, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
  };
  /** 끌다 놓은 것은 탭 누르기로 치지 않는다 */
  const guardClick = (e: React.MouseEvent) => {
    if (!justDragged.current) return;
    e.preventDefault();
    e.stopPropagation();
  };
  return { view, start, guardClick };
}
