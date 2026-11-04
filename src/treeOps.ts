// 파일 트리 오른쪽 클릭: 새 파일·새 폴더·이름 바꾸기·휴지통으로 옮기기.
// 디스크 작업은 Rust(files.rs create_entry·rename_entry·trash_entry)가 다시 검사한다. 여기 검사는 입력칸에서 먼저 알려 주려는 것.
import { api, errorText } from "./api";
import type { MenuItem } from "./components/Overlays";
import { draftRelsUnder, dropDraft, moveDrafts } from "./extensions/editor/drafts";
import { parentRel } from "./fileDrop";
import { t } from "./i18n";
import { baseName, movedRel, stemEnd } from "./logic";
import { useStore } from "./store";
import { TREE_REVEAL, type TreeReveal } from "./treeDrag";

/** 오른쪽 클릭한 곳: 폴더 줄, 파일 줄, 빈 곳(워크트리 맨 위) */
export type TreeSpot = { kind: "dir"; rel: string } | { kind: "file"; rel: string } | { kind: "root" };

/** 새 파일·폴더를 만들 폴더: 폴더면 그 안, 파일이면 그 파일이 든 폴더, 빈 곳이면 맨 위("") */
export function spotDir(spot: TreeSpot): string {
  return spot.kind === "dir" ? spot.rel : spot.kind === "file" ? parentRel(spot.rel) : "";
}

const fold = (s: string) => s.normalize("NFC").toLowerCase();

/**
 * 입력한 새 이름의 문제(없으면 null). files.rs check_name 과 같은 규칙에 더해 같은 폴더의 이름(siblings)과 겹치는지 본다.
 * 맥 기본 디스크는 대소문자·한글 자모 나눔을 가리지 않으므로 그것까지 같은 이름으로 본다. current 는 이름을 바꾸는 항목의 지금 이름
 * (대소문자만 바꾸는 것은 된다). 앞뒤 빈칸은 부르는 쪽에서 지운다.
 */
export function nameProblem(name: string, siblings: string[], current?: string): string | null {
  if (!name) return t("이름을 입력하세요");
  if (name === "." || name === "..") return t("쓸 수 없는 이름이에요: {name}", { name });
  if (name.includes("/")) return t("이름에 / 는 쓸 수 없어요");
  for (const ch of name) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return t("이름에 줄바꿈 같은 제어 문자는 쓸 수 없어요");
  }
  if (name.toLowerCase() === ".git") return t(".git 이라는 이름은 쓸 수 없어요");
  if (new TextEncoder().encode(name).length > 255) return t("이름이 너무 길어요(255바이트까지)");
  const mine = current === undefined ? null : fold(current);
  if (fold(name) !== mine && siblings.some((s) => fold(s) === fold(name))) return t("같은 이름이 이미 있어요: {name}", { name });
  return null;
}

export interface TreeMenuActions {
  newEntry: (dir: string, isDir: boolean) => void;
  rename: (rel: string, isDir: boolean) => void;
  trash: (rel: string, isDir: boolean) => void;
}

/** 오른쪽 클릭 메뉴 항목 */
export function treeMenu(spot: TreeSpot, a: TreeMenuActions): MenuItem[] {
  const dir = spotDir(spot);
  const items: MenuItem[] = [
    { label: t("새 파일…"), onClick: () => a.newEntry(dir, false), testId: "tree-new-file" },
    { label: t("새 폴더…"), onClick: () => a.newEntry(dir, true), testId: "tree-new-folder" },
  ];
  if (spot.kind === "root") return items;
  const isDir = spot.kind === "dir";
  return [
    ...items,
    { label: "", separator: true },
    { label: t("이름 바꾸기…"), onClick: () => a.rename(spot.rel, isDir), testId: "tree-rename" },
    { label: t("휴지통으로 옮기기"), danger: true, onClick: () => a.trash(spot.rel, isDir), testId: "tree-trash" },
  ];
}

const st = () => useStore.getState();

/** 폴더를 펼쳐 새로 생긴 것이 보이게(트리가 TREE_REVEAL 을 듣는다) */
function reveal(worktree: string, dir: string) {
  window.dispatchEvent(new CustomEvent<TreeReveal>(TREE_REVEAL, { detail: { worktree, dir } }));
}

/** 새 파일·새 폴더. siblings = 그 폴더에 이미 있는 이름. 만들면 새 상대 경로 */
export async function newEntry(worktree: string, dir: string, isDir: boolean, siblings: string[]): Promise<string | null> {
  const values = await st().promptForm({
    title: isDir ? t("새 폴더") : t("새 파일"),
    body: t("{dir} 폴더에 만들어요.", { dir: dir || baseName(worktree) }),
    fields: [{ key: "name", label: t("이름|파일 이름"), value: "", placeholder: isDir ? "docs" : "notes.md" }],
    confirmLabel: t("만들기"),
    validate: (v) => nameProblem(v.name.trim(), siblings),
  });
  if (!values) return null;
  try {
    const rel = await api.fsCreate(worktree, dir, values.name.trim(), isDir);
    st().bumpFs(worktree, [rel]);
    reveal(worktree, isDir ? rel : dir);
    // 새 파일은 바로 연다. md 도 빈 미리보기 대신 '내용'(파일 편집을 켜 두었으면 가운데 탭에서 바로 쓸 수 있다)
    if (!isDir) st().openViewer({ kind: "file", rel, mode: "preview" }, { exact: true });
    return rel;
  } catch (e) {
    st().toast("error", t("만들지 못했어요: {error}", { error: errorText(e) }));
    return null;
  }
}

/** 이름 바꾸기. 열어 둔 보기·탭·저장하지 않은 수정이 새 경로를 따라간다. 바꾸면 새 상대 경로 */
export async function renameEntry(worktree: string, rel: string, isDir: boolean, siblings: string[]): Promise<string | null> {
  const current = baseName(rel);
  const values = await st().promptForm({
    title: t("이름 바꾸기"),
    body: rel,
    fields: [{ key: "name", label: t("새 이름"), value: current, selectEnd: stemEnd(current, isDir) }],
    confirmLabel: t("바꾸기|이름"),
    validate: (v) => nameProblem(v.name.trim(), siblings, current),
  });
  const name = values?.name.trim();
  if (!name || name === current) return null;
  try {
    const to = await api.fsRename(worktree, rel, name);
    moveDrafts(worktree, rel, to);
    st().followPaths(worktree, rel, to);
    st().bumpFs(worktree, [rel, to]);
    return to;
  } catch (e) {
    st().toast("error", t("이름을 바꾸지 못했어요: {error}", { error: errorText(e) }));
    return null;
  }
}

/** 휴지통으로 옮기기(확인창). 저장하지 않은 수정이 있으면 확인창에 적는다. 옮기면 true */
export async function trashEntry(worktree: string, rel: string, isDir: boolean): Promise<boolean> {
  const unsaved = draftRelsUnder(worktree, rel);
  const body = [
    isDir ? t("{rel} 폴더를 안의 것까지 휴지통으로 옮겨요.", { rel }) : t("{rel} 을(를) 휴지통으로 옮겨요.", { rel }),
    t("Finder 의 휴지통에서 되살릴 수 있어요."),
    unsaved.length ? `\n${t("저장하지 않은 수정 {n}개는 사라져요:", { n: unsaved.length })}\n${unsaved.map((r) => `· ${r}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const ok = await st().ask({ title: t("휴지통으로 옮기기"), body, danger: true, confirmLabel: t("휴지통으로") });
  if (!ok) return false;
  try {
    await api.fsTrash(worktree, rel);
  } catch (e) {
    st().toast("error", errorText(e));
    return false;
  }
  for (const r of unsaved) dropDraft(worktree, r);
  st().followPaths(worktree, rel, null);
  st().bumpFs(worktree, [rel]);
  st().toast("success", t("휴지통으로 옮겼어요: {name}", { name: baseName(rel) }));
  return true;
}

/** 트리의 펼친 폴더 목록을 이름 바꾼 폴더를 따라 고친다 */
export function followExpanded(expanded: Set<string>, from: string, to: string): Set<string> {
  return new Set([...expanded].map((r) => movedRel(r, from, to) ?? r));
}
