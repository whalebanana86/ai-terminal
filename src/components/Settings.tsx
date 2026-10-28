import { listen } from "@tauri-apps/api/event";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorText, type EditorApp, type MemoryStatus } from "../api";
import { EXTENSIONS, useExtensions, type ExtensionId } from "../extensions";
import { getExternalEditor, setExternalEditor } from "../externalEditor";
import { lang, setLang, t } from "../i18n";
import { useStore } from "../store";
import { useMemoryStatus } from "../panels/MemoryStart";
import { LicensesDialog } from "./Licenses";
import { getThemePref, setThemePref, type ThemePref } from "../theme";

/** 설정 창(언어·화면 모드·기능·외부 편집기). 맥 메뉴 막대의 "코드행방 → 설정… (⌘,)" 이 open-settings 를 보내면 열린다. */
export function SettingsDialog() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePref>(getThemePref);
  const [licenses, setLicenses] = useState(false);
  useEffect(() => {
    const un = listen("open-settings", () => setOpen(true));
    return () => void un.then((f) => f());
  }, []);
  useEffect(() => {
    if (!open) return;
    // 라이선스 창이 떠 있으면 그것만 닫는다
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (licenses ? setLicenses(false) : setOpen(false));
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, licenses]);
  if (!open) return null;
  const pickTheme = (p: ThemePref) => {
    setTheme(p);
    setThemePref(p);
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="modal settings-modal" role="dialog" aria-label={t("설정")} data-testid="settings-dialog">
        <div className="settings-head">
          <h3>{t("설정")}</h3>
          <button className="icon-btn ghost" onClick={() => setOpen(false)} aria-label={t("닫기")} title={t("닫기")}>
            <X size={14} aria-hidden />
          </button>
        </div>
        <div className="settings-row">
          <span className="settings-label">{t("언어")}</span>
          <div className="seg">
            <button className={lang === "ko" ? "on" : ""} onClick={() => lang !== "ko" && setLang("ko")} data-lang="ko">
              한국어
            </button>
            <button className={lang === "en" ? "on" : ""} onClick={() => lang !== "en" && setLang("en")} data-lang="en">
              English
            </button>
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-label">{t("화면 모드")}</span>
          <div className="seg">
            {(
              [
                ["system", t("시스템")],
                ["light", t("밝게")],
                ["dark", t("어둡게")],
              ] as [ThemePref, string][]
            ).map(([p, label]) => (
              <button key={p} className={theme === p ? "on" : ""} onClick={() => pickTheme(p)} data-theme-pref={p} title={p === "system" ? t("맥 설정을 따라가요") : undefined}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <ExternalEditorRow />
        <div className="settings-section">
          <h4>{t("기능")}</h4>
          {EXTENSIONS.map((e) => (
            <FeatureRow key={e.id} id={e.id} title={e.title()} description={e.description()} />
          ))}
        </div>
        <MemorySection />
        <div className="settings-row settings-foot">
          <span className="settings-label">{t("오픈소스 라이선스")}</span>
          <button className="btn btn-small" onClick={() => setLicenses(true)} data-testid="open-licenses">
            {t("보기")}
          </button>
        </div>
      </div>
      {licenses && <LicensesDialog onClose={() => setLicenses(false)} />}
    </div>
  );
}

/** 기능 하나 켜고 끄기. 파일 편집은 켤 때 맥 확인창이 뜨고, 취소하면 꺼진 채로 남는다. */
function FeatureRow({ id, title, description }: { id: ExtensionId; title: string; description: string }) {
  const on = useExtensions((s) => s.enabled[id]);
  const setOn = useExtensions((s) => s.set);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      await setOn(id, !on);
    } catch (e) {
      useStore.getState().toast("error", errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="feature-row" data-feature={id}>
      <span className="feature-text">
        <span className="feature-title">{title}</span>
        <span className="feature-desc">{description}</span>
      </span>
      <input type="checkbox" className="switch" role="switch" checked={on} disabled={busy} onChange={() => void toggle()} aria-label={title} />
    </label>
  );
}

function ExternalEditorRow() {
  const [apps, setApps] = useState<EditorApp[] | null>(null);
  const [pick, setPick] = useState(getExternalEditor);
  useEffect(() => {
    api.editorsInstalled().then(setApps, () => setApps([]));
  }, []);
  const choose = (id: string) => {
    setPick(id);
    setExternalEditor(id);
  };
  // 고른 편집기를 지웠으면 목록에 없으니 자동처럼 보여 준다
  const value = pick === "auto" || apps?.some((a) => a.id === pick) ? pick : "auto";
  return (
    <div className="settings-row">
      <span className="settings-label">{t("외부 편집기")}</span>
      <select className="settings-select" value={value} onChange={(e) => choose(e.target.value)} aria-label={t("외부 편집기")} data-testid="external-editor">
        <option value="auto">{t("자동 (설치된 편집기)")}</option>
        {(apps ?? []).map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </div>
  );
}

const mb = (n: number) => `${Math.round(n / 1e6).toLocaleString()} MB`;

/** 작업 기억: 지난 대화를 이 맥 안에 보관하고 의미로 찾는다. 켜면 모델을 한 번 내려받는다. */
function MemorySection() {
  const st = useMemoryStatus();
  const [busy, setBusy] = useState(false);
  if (!st) return null;
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      useStore.getState().toast("error", errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const confirm = (title: string, body: string, label: string) => useStore.getState().ask({ title, body, confirmLabel: label, danger: true });
  const clear = () =>
    run(async () => {
      if (await confirm(t("기억 지우기"), t("보관한 지난 작업 기록을 모두 지웁니다. 지금 남아 있는 대화 기록에서 다시 모으지만, Claude 가 이미 지운 오래된 대화는 돌아오지 않아요."), t("지우기"))) await api.memoryClear();
    });
  const removeModel = () =>
    run(async () => {
      if (await confirm(t("모델 지우기"), t("내려받은 모델과 실행 라이브러리를 지우고 작업 기억을 끕니다. 보관한 기록은 남아요."), t("지우기"))) await api.memoryRemoveModel();
    });
  return (
    <div className="settings-section" data-testid="memory-settings">
      <h4>{t("작업 기억")}</h4>
      <label className="feature-row" data-feature="memory">
        <span className="feature-text">
          <span className="feature-title">{t("지난 작업 기억하기")}</span>
          <span className="feature-desc">{t("지난 대화·오류·수정 내역을 이 맥 안에 보관하고 의미로 찾아요. 새 세션에 필요한 기록만 넣어 토큰을 아껴요. 기록은 밖으로 보내지 않아요.")}</span>
        </span>
        <input type="checkbox" className="switch" role="switch" checked={st.enabled} disabled={busy || !st.supported} onChange={() => void run(() => api.memorySetEnabled(!st.enabled))} aria-label={t("지난 작업 기억하기")} />
      </label>
      <MemoryState st={st} onRetry={() => void run(() => api.memorySetEnabled(true))} />
      {st.supported && (st.turns > 0 || st.modelBytes > 0) && (
        <div className="mem-actions">
          {st.turns > 0 && (
            <button className="btn btn-small" disabled={busy} onClick={() => void clear()}>
              {t("기억 지우기")}
            </button>
          )}
          {st.modelBytes > 0 && (
            <button className="btn btn-small" disabled={busy || st.state === "downloading"} onClick={() => void removeModel()}>
              {t("모델 지우기 ({size})", { size: mb(st.modelBytes) })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function MemoryState({ st, onRetry }: { st: MemoryStatus; onRetry: () => void }) {
  let line: React.ReactNode;
  switch (st.state) {
    case "unsupported":
      line = t("이 맥에서는 쓸 수 없어요 (Apple Silicon, macOS 14 이상 필요)");
      break;
    case "off":
      line = st.modelBytes > 0 ? t("꺼져 있어요. 모델은 받아 둔 상태예요.") : t("켜면 모델과 실행 라이브러리(약 {size})를 한 번 내려받아요.", { size: mb(st.downloadTotal) });
      break;
    case "downloading":
      return (
        <div className="mem-state" data-state={st.state}>
          <progress max={st.downloadTotal} value={st.downloaded} />
          <span>{t("내려받는 중 {done} / {total}", { done: mb(st.downloaded), total: mb(st.downloadTotal) })}</span>
        </div>
      );
    case "download":
      return (
        <div className="mem-state" data-state={st.state}>
          <span className="warn-text">{st.error ?? t("모델을 다 받지 못했어요.")}</span>
          <button className="btn btn-small" onClick={onRetry}>
            {t("다시 받기")}
          </button>
        </div>
      );
    case "indexing":
      line = t("지난 기록을 정리하는 중 {done} / {total}", { done: st.embedded.toLocaleString(), total: st.chunks.toLocaleString() });
      break;
    default:
      line = t("기록 {n}개 보관 중 · {size}", { n: st.turns.toLocaleString(), size: mb(st.dbBytes) });
  }
  return (
    <div className="mem-state" data-state={st.state}>
      <span>{line}</span>
      {st.error && <span className="warn-text">{st.error}</span>}
    </div>
  );
}
