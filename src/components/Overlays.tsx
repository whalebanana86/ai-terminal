import { useEffect, useRef } from "react";
import { useStore } from "../store";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function ConfirmDialog() {
  const req = useStore((s) => s.confirm);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!req) return;
    // 위험한 작업은 기본 포커스를 "취소"에 둔다.
    if (!req.danger) okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") req.resolve(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req]);
  if (!req) return null;
  return (
    <div className="modal-backdrop" onMouseDown={() => req.resolve(false)}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={req.title} onMouseDown={(e) => e.stopPropagation()}>
        <h3>{req.title}</h3>
        <p className="modal-body">{req.body}</p>
        <div className="modal-actions">
          <button className="btn" autoFocus={req.danger} onClick={() => req.resolve(false)}>
            취소
          </button>
          <button ref={okRef} className={req.danger ? "btn btn-danger" : "btn btn-primary"} onClick={() => req.resolve(true)}>
            {req.confirmLabel ?? "확인"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 작은 공통 조각들 */
export function AgentBadge({ agent, small }: { agent: string; small?: boolean }) {
  return (
    <span className={`agent-badge agent-${agent}${small ? " small" : ""}`} title={agent === "claude" ? "Claude Code" : "Codex"}>
      {agent === "claude" ? "Claude" : "Codex"}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}
