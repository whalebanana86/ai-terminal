import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { api, errorText, type TransferOutcome } from "./api";
import { beginOutgoing, endOutgoing, outgoingActive, type DropPlan } from "./fileDrop";
import { t } from "./i18n";
import { baseName } from "./logic";
import { useStore } from "./store";

/**
 * 파일 트리에서 끌기. 줄을 누른 채 조금 움직이면 맥 네이티브 드래그를 시작한다(tauri-plugin-drag):
 * Finder·메일·메신저 등에 놓으면 실제 파일이 복사돼 넘어가고, 우리 창 안에 놓으면 wry 의 파일 드롭으로 돌아와
 * fileDrop.ts 가 '터미널·입력칸 → 경로 넣기, 같은 워크트리 폴더 → 이동' 으로 처리한다.
 * 드래그가 시작되면 맥이 마우스를 맡으므로(놓을 때까지 웹뷰에 마우스 이벤트가 오지 않음) 클릭과는 겹치지 않는다.
 */

/** 이만큼(px) 움직여야 끌기로 본다: 누르고 살짝 떨린 클릭이 끌기가 되지 않게 */
const DRAG_THRESHOLD = 5;

export interface TreeItem {
  worktree: string;
  rel: string;
  name: string;
  dir: boolean;
}

export function absPath(worktree: string, rel: string): string {
  return `${worktree.replace(/\/+$/, "")}/${rel}`;
}

/** 트리 줄의 mousedown 에서 부른다. 누른 채 움직이면 그때 드래그를 시작한다. */
export function armTreeDrag(e: { button: number; clientX: number; clientY: number; metaKey: boolean; ctrlKey: boolean }, item: TreeItem) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || outgoingActive()) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  const move = (m: MouseEvent) => {
    if (!(m.buttons & 1)) return stop();
    if (Math.hypot(m.clientX - x0, m.clientY - y0) < DRAG_THRESHOLD) return;
    stop();
    void begin(item);
  };
  const stop = () => {
    window.removeEventListener("mousemove", move, true);
    window.removeEventListener("mouseup", stop, true);
    window.removeEventListener("blur", stop);
  };
  window.addEventListener("mousemove", move, true);
  window.addEventListener("mouseup", stop, true);
  window.addEventListener("blur", stop);
}

async function begin(item: TreeItem) {
  if (outgoingActive()) return;
  const path = absPath(item.worktree, item.rel);
  // 창 안으로 돌아왔을 때 우리가 시작한 것임을 알아보도록 먼저 기억해 둔다
  beginOutgoing({ worktree: item.worktree, rels: [item.rel], paths: [path] });
  try {
    // copy: Finder 에 놓아도 워크트리의 원본은 그대로 남는다
    await startDrag({ item: [path], icon: dragImage(item.name, item.dir), mode: "copy" }, () => endOutgoing());
  } catch (err) {
    endOutgoing(true);
    useStore.getState().toast("error", t("끌기를 시작하지 못했어요: {error}", { error: errorText(err) }));
  }
}

// ───────────── 끄는 동안 보이는 그림 ─────────────

/** 이름표 그림(PNG data URL). 레티나에서 흐리지 않게 2배로 그리고 PNG 에 144dpi 를 적어 맥이 절반 크기(포인트)로 보이게 한다. */
function dragImage(name: string, dir: boolean): string {
  const scale = 2;
  const css = getComputedStyle(document.documentElement);
  const font = `12px ${getComputedStyle(document.body).fontFamily || "-apple-system, sans-serif"}`;
  const label = (name.length > 48 ? `${name.slice(0, 47)}…` : name) + (dir ? "/" : "");
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  g.font = font;
  const w = Math.max(24, Math.ceil(g.measureText(label).width) + 20);
  const h = 24;
  c.width = w * scale;
  c.height = h * scale;
  g.scale(scale, scale);
  g.beginPath();
  // roundRect 는 Safari 16 부터(맥 12 기본 웹뷰에는 없을 수 있다)
  if (typeof g.roundRect === "function") g.roundRect(0.5, 0.5, w - 1, h - 1, 6);
  else g.rect(0.5, 0.5, w - 1, h - 1);
  g.fillStyle = "rgba(18, 21, 27, 0.92)";
  g.fill();
  g.strokeStyle = css.getPropertyValue("--accent").trim() || "#4cc2ff";
  g.stroke();
  g.font = font;
  g.fillStyle = "#e8eaee";
  g.textBaseline = "middle";
  g.fillText(label, 10, h / 2 + 0.5);
  const png = Uint8Array.from(atob(c.toDataURL("image/png").split(",")[1] ?? ""), (ch) => ch.charCodeAt(0));
  // 플러그인은 그림을 못 읽으면 맥 쪽에서 패닉(배포 빌드는 앱이 꺼짐)하므로 깨진 그림은 여기서 막는다
  if (png.length < 33 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) throw new Error("drag image");
  let bin = "";
  for (const b of pngWithDpi(png, 72 * scale)) bin += String.fromCharCode(b);
  return `data:image/png;base64,${btoa(bin)}`;
}

const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tbl[n] = c >>> 0;
  }
  return tbl;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG 의 IHDR 바로 뒤에 해상도(pHYs) 조각을 넣는다. canvas 가 만든 PNG 에는 해상도가 없어 맥이 72dpi(픽셀 = 포인트)로 본다. */
export function pngWithDpi(png: Uint8Array, dpi: number): Uint8Array {
  // 8바이트 서명 + IHDR(길이 4 + 이름 4 + 내용 13 + CRC 4) = 33
  const at = 33;
  if (png.length < at || String.fromCharCode(...png.slice(12, 16)) !== "IHDR") return png;
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const v = new DataView(chunk.buffer);
  v.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  v.setUint32(8, ppm);
  v.setUint32(12, ppm);
  chunk[16] = 1; // 단위: 미터
  v.setUint32(17, crc32(chunk.subarray(4, 17)));
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, at), 0);
  out.set(chunk, at);
  out.set(png.subarray(at), at + chunk.length);
  return out;
}

// ───────────── 트리 폴더에 놓은 뒤: 복사·이동 ─────────────

/** 놓은 폴더를 트리에서 펼쳐 결과가 보이게 하라는 신호(FileTree 가 듣는다) */
export const TREE_REVEAL = "aiterm:tree-reveal";
export type TreeReveal = { worktree: string; dir: string };

function listNames(names: string[]): string {
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? t("{names} 외 {n}개", { names: shown, n: names.length - 3 }) : shown;
}

/** 결과 알림 글(성공 하나, 실패 하나) */
export function transferMessages(kind: "copy" | "move", where: string, r: TransferOutcome): { ok: string | null; error: string | null } {
  const parts: string[] = [];
  if (r.done.length) {
    const names = listNames(r.done.map(baseName));
    parts.push(kind === "copy" ? t("{dir} 폴더에 복사했어요: {names}", { dir: where, names }) : t("{dir} 폴더로 옮겼어요: {names}", { dir: where, names }));
  }
  if (r.renamed.length) parts.push(t("같은 이름이 있어 새 이름으로 두었어요: {names}", { names: listNames(r.renamed.map((x) => x.to)) }));
  if (r.skipped) parts.push(t("특수 파일 {n}개는 건너뛰었어요", { n: r.skipped }));
  let error: string | null = null;
  if (r.failed.length) {
    const f = r.failed[0];
    error = kind === "copy" ? t("복사하지 못했어요: {name} — {reason}", { name: f.name, reason: f.reason }) : t("옮기지 못했어요: {name} — {reason}", { name: f.name, reason: f.reason });
    if (r.failed.length > 1) error += ` ${t("(외 {n}개)", { n: r.failed.length - 1 })}`;
  }
  return { ok: parts.length ? parts.join(" · ") : null, error };
}

/** 트리 폴더에 놓은 것을 복사·이동하고 결과를 알린다. 파일 감시를 기다리지 않고 트리·Git 변경 목록을 다시 읽게 한다. */
export async function runTransfer(plan: Extract<DropPlan, { kind: "copy" | "move" }>) {
  const st = useStore.getState();
  const where = plan.dir || baseName(plan.worktree);
  try {
    const r = plan.kind === "copy" ? await api.fsCopyIn(plan.worktree, plan.dir, plan.paths) : await api.fsMove(plan.worktree, plan.dir, plan.rels);
    if (r.done.length) {
      st.bumpFs(plan.worktree, plan.kind === "move" ? [...plan.rels, ...r.done] : r.done);
      window.dispatchEvent(new CustomEvent<TreeReveal>(TREE_REVEAL, { detail: { worktree: plan.worktree, dir: plan.dir } }));
    }
    const m = transferMessages(plan.kind, where, r);
    if (m.ok) st.toast(r.renamed.length || r.skipped ? "info" : "success", m.ok);
    if (m.error) st.toast("error", m.error);
  } catch (e) {
    st.toast("error", errorText(e));
  }
}
