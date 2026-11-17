import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { dismissToast } from "../state/actions";
import { useStore } from "../state/store";
import { Icon } from "./Icon";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Measure the actual bottom stack, including safe areas and larger navigation labels.
    const player = document.querySelector<HTMLElement>(".playerbar");
    const nav = document.querySelector<HTMLElement>(".mobile-nav");
    const update = () => {
      const stack = [player, nav].filter((el): el is HTMLElement => !!el && el.getClientRects().length > 0);
      const top = Math.min(window.innerHeight, ...stack.map((el) => el.getBoundingClientRect().top));
      host.current?.style.setProperty("--phone-toast-bottom", `${window.innerHeight - top + 12}px`);
    };
    const observer = new ResizeObserver(update);
    if (player) observer.observe(player);
    if (nav) observer.observe(nav);
    window.addEventListener("resize", update);
    update();
    return () => { observer.disconnect(); window.removeEventListener("resize", update); };
  }, []);
  return (
    <div className="toasts" ref={host} role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone ?? "default"}`}>
          {t.tone === "success" ? <Icon name="checkCircle" size={20} className="toast-icon" /> : t.tone === "error" ? <Icon name="help" size={20} className="toast-icon" /> : t.progress !== undefined ? <Icon name="download" size={20} className="toast-icon" /> : null}
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
