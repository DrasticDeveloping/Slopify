import { createContext, useContext, useEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { closeModal, modalOpenerElement } from "../../state/actions";
import { Icon } from "../Icon";

export const ClosingContext = createContext(false);

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

interface ShellProps {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  footer?: ReactNode;
  icon?: string;
  /** A cover beside the title (a playlist's, a song's): the dialog is about that thing, and shows it. */
  art?: ReactNode;
  /** A colour the dialog is washed in from the top, usually the art's. */
  tint?: string;
  className?: string;
  /** What closing does (the close button, Escape, clicking outside); closing the current dialog by default. */
  onClose?: () => void;
  /** A second layer over a dialog (a confirmation): it hands focus back to what had it, not to the dialog's opener. */
  layer?: "modal" | "confirm";
}

export function Shell({ title, subtitle, children, size = "md", footer, icon, art, tint, className, onClose = closeModal, layer = "modal" }: ShellProps) {
  const closing = useContext(ClosingContext);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const recorded = layer === "modal" ? modalOpenerElement() : null;
    const previous = recorded && recorded !== document.body ? recorded : (document.activeElement as HTMLElement | null);
    const el = ref.current;
    // React handles autoFocus itself (no attribute is left), so a dialog marks its default with data-autofocus.
    const first = el?.querySelector<HTMLElement>("[data-autofocus],input:not([type=checkbox]):not([type=radio]):not([type=range])") ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => {
      if (layer === "confirm") return;
      if (previous?.isConnected && previous !== document.body) previous.focus();
    };
  }, []);

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
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
    <div className={`modal-layer${layer === "confirm" ? " confirm-layer" : ""}${closing ? " closing" : ""}`} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`modal ${size}${art ? " has-art" : ""}${tint ? " tinted" : ""}${className ? ` ${className}` : ""}`}
        style={tint ? ({ "--modal-tint": tint } as CSSProperties) : undefined}
        role={layer === "confirm" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-label={title}
        onKeyDown={onKey}
      >
        <span className="sheet-grip" aria-hidden="true" />
        <header className="modal-head">
          {art ? <span className="modal-art">{art}</span> : icon ? <span className="modal-icon"><Icon name={icon} size={22} /></span> : null}
          <div>
            <h2>{title}</h2>
            {subtitle ? <p className="muted small">{subtitle}</p> : null}
          </div>
          <button type="button" className="icon-btn round" onClick={onClose} aria-label="Close">
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
