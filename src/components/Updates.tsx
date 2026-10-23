import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { errorText } from "../api";
import { t } from "../i18n";

interface UpdateInfo {
  currentVersion: string;
  version: string;
  notes: string;
  available: boolean;
  automatic: boolean;
}
type Phase = "checking" | "ready" | "installing" | "error";

export function UpdateDialog() {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("checking");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const busy = useRef(false);
  const installing = phase === "installing";

  const check = async () => {
    setOpen(true);
    if (busy.current) return;
    busy.current = true;
    setPhase("checking");
    setInfo(null);
    setError("");
    try {
      setInfo(await invoke<UpdateInfo>("check_update"));
      setPhase("ready");
    } catch (e) {
      setError(errorText(e));
      setPhase("error");
    } finally { busy.current = false; }
  };

  useEffect(() => {
    const subscriptions = [
      listen("check-updates", () => void check()),
      listen<{ downloaded: number; total: number | null }>("update-progress", ({ payload }) => {
        setProgress(payload.total ? Math.min(100, Math.round(payload.downloaded / payload.total * 100)) : null);
      }),
    ];
    return () => subscriptions.forEach((p) => void p.then((unlisten) => unlisten()));
  }, []);

  useEffect(() => {
    if (!open || installing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, installing]);

  const install = async () => {
    if (busy.current) return;
    busy.current = true;
    setPhase("installing");
    setError("");
    setProgress(null);
    try {
      await invoke("install_update");
    } catch (e) {
      setError(errorText(e));
      setPhase("ready");
    } finally { busy.current = false; }
  };

  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (!installing && e.target === e.currentTarget) setOpen(false); }}>
      <div className="modal update-modal" role="dialog" aria-modal="true" aria-labelledby="update-title" data-testid="update-dialog">
        <h3 id="update-title">{t("업데이트 확인")}</h3>
        <div role="status" aria-live="polite">
          {phase === "checking" && <p>{t("새 버전을 확인하는 중…")}</p>}
          {phase === "error" && <p>{t("업데이트를 확인하지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.")}</p>}
          {info && !installing && <>
            <p>{info.available ? t("새 버전 {version}을 사용할 수 있어요.", { version: info.version }) : t("최신 버전입니다. (현재 {version})", { version: info.currentVersion })}</p>
            {info.available && <p className="muted">{t("현재 버전: {version}", { version: info.currentVersion })}</p>}
            {info.available && <p>{info.automatic ? t("설치 후 앱이 다시 시작됩니다. 터미널에서 실행 중인 에이전트는 끊기지 않고 새 버전에서 이어집니다.") : t("이 버전은 다운로드 페이지에서 DMG를 받아 설치해 주세요.")}</p>}
            {info.available && info.notes && <pre className="update-notes">{info.notes}</pre>}
          </>}
          {installing && <>
            <p>{t("업데이트를 설치하는 중… 완료되면 앱이 다시 시작됩니다.")}</p>
            <progress max={100} value={progress ?? undefined} aria-label={t("다운로드 진행률")} />
            {progress !== null && <span> {progress}%</span>}
          </>}
        </div>
        {error && <p className="update-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button onClick={() => setOpen(false)} disabled={installing}>{t("닫기")}</button>
          {phase === "error" && <button className="primary" onClick={() => void check()}>{t("다시 확인")}</button>}
          {phase === "ready" && info?.available && (info.automatic
            ? <button className="primary" onClick={() => void install()}>{t("설치하고 다시 시작")}</button>
            : <button className="primary" onClick={() => void invoke("open_update_download").catch((e) => setError(errorText(e)))}>{t("다운로드 페이지 열기")}</button>)}
        </div>
      </div>
    </div>
  );
}
