// 파일 편집을 켜면 파일은 오른쪽 아래(좁음) 대신 가운데 칸 탭으로 연다.
// 에이전트 화면(터미널)은 그대로 두고 그 위에 파일 화면을 덮어서, 탭을 오가도 터미널이 끊기거나 크기가 바뀌지 않는다.
import { Bot, X } from "lucide-react";
import { dropDraft, useHasDraft } from "../extensions/editor/drafts";
import { FileIcon } from "../fileIcons";
import { t } from "../i18n";
import { baseName } from "../logic";
import { useStore, type FileTab } from "../store";
import { FileViewer } from "./FilePanel";

export function CenterTabBar() {
  const tabs = useStore((s) => s.fileTabs);
  const active = useStore((s) => s.activeTab);
  const setActive = useStore((s) => s.setActiveTab);
  return (
    <div className="center-tabs" role="tablist" aria-label={t("가운데 칸 탭")}>
      <button role="tab" aria-selected={active === null} className={`center-tab${active === null ? " on" : ""}`} onClick={() => setActive(null)} data-tab="agent">
        <Bot size={13} aria-hidden /> <span>{t("에이전트")}</span>
      </button>
      {tabs.map((tab) => (
        <FileTabButton key={tab.id} tab={tab} on={active === tab.id} />
      ))}
    </div>
  );
}

function FileTabButton({ tab, on }: { tab: FileTab; on: boolean }) {
  const setActive = useStore((s) => s.setActiveTab);
  const setTabViewer = useStore((s) => s.setTabViewer);
  const ask = useStore((s) => s.ask);
  const v = tab.viewer;
  const dirty = useHasDraft(tab.worktree, v.rel) && v.kind === "file";
  const name = baseName(v.rel);
  const close = async () => {
    if (dirty) {
      const ok = await ask({
        title: t("{name} 탭 닫기", { name }),
        body: t("저장하지 않은 수정이 있어요. 닫으면 수정을 버려요."),
        danger: true,
        confirmLabel: t("버리고 닫기"),
      });
      if (!ok) return;
      dropDraft(tab.worktree, v.rel);
    }
    setTabViewer(tab.id, null);
  };
  return (
    <div
      role="tab"
      aria-selected={on}
      tabIndex={0}
      className={`center-tab${on ? " on" : ""}`}
      onClick={() => setActive(tab.id)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setActive(tab.id)}
      onAuxClick={(e) => e.button === 1 && void close()}
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
