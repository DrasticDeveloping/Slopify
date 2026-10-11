import { createContext, useContext, useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { closeModal, modalOpenerElement } from "../../state/actions";
import { Icon } from "../Icon";

export const ClosingContext = createContext(false);

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function Shell({ title, subtitle, children, size = "md", footer, icon, className }: { title: string; subtitle?: ReactNode; children: ReactNode; size?: "sm" | "md" | "lg" | "xl"; footer?: ReactNode; icon?: string; className?: string }) {
  const closing = useContext(ClosingContext);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const recorded = modalOpenerElement();
    const previous = recorded && recorded !== document.body ? recorded : (document.activeElement as HTMLElement | null);
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("[autofocus], input:not([type=checkbox]):not([type=radio]):not([type=range])") ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => {
      if (previous?.isConnected && previous !== document.body) previous.focus();
    };
  }, []);

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      closeModal();
    }
    if (e.key === "Tab" && ref.current) {
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className={`modal-layer${closing ? " closing" : ""}`} onPointerDown={(e) => e.target === e.currentTarget && closeModal()}>
      <div ref={ref} className={`modal ${size}${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKey}>
        <header className="modal-head">
          {icon ? <span className="modal-icon"><Icon name={icon} size={22} /></span> : null}
          <div>
            <h2>{title}</h2>
            {subtitle ? <p className="muted small">{subtitle}</p> : null}
          </div>
          <button type="button" className="icon-btn round" onClick={closeModal} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`toggle${checked ? " on" : ""}`} onClick={() => onChange(!checked)} disabled={disabled}>
      <span className="toggle-thumb" />
    </button>
  );
}
