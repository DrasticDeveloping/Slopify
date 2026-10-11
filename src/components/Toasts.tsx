import type { CSSProperties } from "react";
import { dismissToast } from "../state/actions";
import { useStore } from "../state/store";
import { Icon } from "./Icon";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone ?? "default"}`}>
          {t.tone === "success" ? <Icon name="checkCircle" size={20} className="toast-icon" /> : t.tone === "error" ? <Icon name="help" size={20} className="toast-icon" /> : null}
          <div className="toast-body">
            <strong>{t.message}</strong>
            {t.detail ? <small>{t.detail}</small> : null}
            {t.progress !== undefined ? (
              // A negative value means "working, size unknown".
              <span className={`toast-progress${t.progress < 0 ? " indeterminate" : ""}`}><i style={{ "--p": Math.max(0, t.progress) } as CSSProperties} /></span>
            ) : null}
          </div>
          {t.action ? (
            <button
              type="button"
              className="text-btn"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button type="button" className="icon-btn sm" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
