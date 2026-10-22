// 파일 편집을 켜면 파일은 오른쪽 아래(좁음) 대신 가운데 칸 탭으로 연다.
// 에이전트 화면(터미널)은 그대로 두고 그 위에 파일 화면을 덮어서, 탭을 오가도 터미널이 끊기거나 크기가 바뀌지 않는다.
import { Bot, X } from "lucide-react";
import { useState } from "react";
import { ContextMenu, type MenuItem } from "../components/Overlays";
import { dropDraft, getDraft, saveDraft, useHasDraft } from "../extensions/editor/drafts";
import { FileIcon } from "../fileIcons";
import { t } from "../i18n";
import { baseName } from "../logic";
import { useStore, type FileTab } from "../store";
import { FileViewer } from "./FilePanel";

/**
 * 탭들을 닫는다. 저장하지 않은 수정이 있으면 저장하고 닫기 / 저장하지 않고 닫기 / 취소 를 묻는다.
 * 저장하지 못한 파일(그사이 밖에서 바뀜 등)은 닫지 않고 남겨 둔다.
 */
export async function closeFileTabs(ids: string[]) {
  const st = useStore.getState();
  const closing = st.fileTabs.filter((x) => ids.includes(x.id));
  const dirty = closing.filter((x) => x.viewer.kind === "file" && getDraft(x.worktree, x.viewer.rel));
  const keep: string[] = [];
  if (dirty.length) {
    const pick = await st.choose({
      title: t("저장하지 않은 수정이 있어요"),
      body: t("저장하지 않은 파일 {n}개:\n{files}\n\n저장하고 닫을까요?", { n: dirty.length, files: dirty.map((x) => `· ${x.viewer.rel}`).join("\n") }),
      confirmLabel: t("저장하고 닫기"),
      altLabel: t("저장하지 않고 닫기"),
    });
    if (!pick) return;
    if (pick === "alt") {
      for (const x of dirty) dropDraft(x.worktree, x.viewer.rel);
    } else {
      const failed: string[] = [];
      for (const x of dirty) {
        const why = await saveDraft(x.worktree, x.viewer.rel);
        if (why) {
          failed.push(`${x.viewer.rel} (${why})`);
          keep.push(x.id);
        }
      }
      if (failed.length) st.toast("error", t("저장하지 못해 닫지 않은 파일: {files}", { files: failed.join(", ") }));
    }
  }
  st.closeTabs(ids.filter((id) => !keep.includes(id)));
}

export function CenterTabBar() {
  const tabs = useStore((s) => s.fileTabs);
  const active = useStore((s) => s.activeTab);
  const setActive = useStore((s) => s.setActiveTab);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const all = tabs.map((x) => x.id);
  const openMenu = (e: React.MouseEvent, id: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    const others = all.filter((x) => x !== id);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        ...(id
          ? [
              { label: t("닫기"), onClick: () => void closeFileTabs([id]), testId: "tab-close" },
              { label: t("다른 탭 모두 닫기"), disabled: others.length === 0, onClick: () => void closeFileTabs(others), testId: "tab-close-others" },
              { label: "", separator: true },
            ]
          : []),
        { label: t("모두 닫기"), disabled: all.length === 0, onClick: () => void closeFileTabs(all), testId: "tab-close-all" },
      ],
    });
  };
  return (
    <div className="center-tabs" role="tablist" aria-label={t("가운데 칸 탭")} onContextMenu={(e) => openMenu(e, null)}>
      <button role="tab" aria-selected={active === null} className={`center-tab${active === null ? " on" : ""}`} onClick={() => setActive(null)} data-tab="agent">
        <Bot size={13} aria-hidden /> <span>{t("에이전트")}</span>
      </button>
      {tabs.map((tab) => (
        <FileTabButton key={tab.id} tab={tab} on={active === tab.id} onMenu={(e) => openMenu(e, tab.id)} />
      ))}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function FileTabButton({ tab, on, onMenu }: { tab: FileTab; on: boolean; onMenu: (e: React.MouseEvent) => void }) {
  const setActive = useStore((s) => s.setActiveTab);
  const v = tab.viewer;
  const dirty = useHasDraft(tab.worktree, v.rel) && v.kind === "file";
  const name = baseName(v.rel);
  const close = () => closeFileTabs([tab.id]);
  return (
    <div
      role="tab"
      aria-selected={on}
      tabIndex={0}
      className={`center-tab${on ? " on" : ""}`}
      onClick={() => setActive(tab.id)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setActive(tab.id)}
      onAuxClick={(e) => e.button === 1 && void close()}
      onContextMenu={onMenu}
      title={`${baseName(tab.worktree)} / ${v.rel}${v.kind === "commit-file" ? ` @ ${v.sha.slice(0, 7)}` : ""}`}
      data-tab={v.rel}
    >
      <FileIcon name={name} />
      <span className="center-tab-name">{name}</span>
      {v.kind === "commit-file" && <code className="sha">{v.sha.slice(0, 7)}</code>}
      {dirty && <span className="tab-dot" aria-label={t("저장 안 됨")} />}
      <button
        className="center-tab-close"
        onClick={(e) => {
          e.stopPropagation();
          void close();
        }}
        aria-label={t("{name} 탭 닫기", { name })}
        title={t("{name} 탭 닫기", { name })}
      >
        <X size={12} aria-hidden />
      </button>
    </div>
  );
}

/** 지금 탭의 파일 화면(에이전트 화면 위에 덮음) */
export function CenterFileView() {
  const tab = useStore((s) => (s.activeTab ? s.fileTabs.find((x) => x.id === s.activeTab) : undefined));
  const setTabViewer = useStore((s) => s.setTabViewer);
  if (!tab) return null;
  return (
    <div className="center-file" role="tabpanel" data-testid="center-file">
      <FileViewer key={tab.id} worktree={tab.worktree} viewer={tab.viewer} onViewer={(v) => setTabViewer(tab.id, v)} />
    </div>
  );
}
