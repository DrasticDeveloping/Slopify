import { useEffect, useState } from "react";
import { answerConfirm } from "../../state/actions";
import { useStore, type ConfirmState } from "../../state/store";
import { Icon } from "../Icon";
import { ClosingContext, Shell } from "./Shell";

/**
 * The app's own "are you sure?" (see ask()), above any open dialog. Cancel is the safe default:
 * Escape, clicking outside and the close button all answer no.
 */
export function ConfirmHost() {
  const confirm = useStore((s) => s.confirm);
  // Kept briefly after it's answered, so it can animate out.
  const [shown, setShown] = useState<ConfirmState | null>(confirm);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (confirm) {
      setShown(confirm);
      setClosing(false);
      return;
    }
    if (!shown) return;
    setClosing(true);
    const t = window.setTimeout(() => {
      setShown(null);
      setClosing(false);
    }, 180);
    return () => clearTimeout(t);
  }, [confirm, shown]);

  if (!shown) return null;
  const no = () => answerConfirm(false);
  return (
    <ClosingContext.Provider value={closing}>
      <Shell
        key={shown.id}
        layer="confirm"
        title={shown.title}
        size="sm"
        className={`confirm${shown.danger ? " danger" : ""}`}
        icon={shown.icon ?? (shown.danger ? "trash" : "help")}
        onClose={no}
        footer={
          <>
            <span className="spacer" />
            <button type="button" className="btn ghost" onClick={no} data-autofocus>{shown.cancelLabel ?? "Cancel"}</button>
            <button type="button" className={`btn ${shown.danger ? "danger solid" : "primary"}`} onClick={() => answerConfirm(true)}>
              {shown.danger ? <Icon name={shown.icon ?? "trash"} size={16} /> : null}
              {shown.confirmLabel}
            </button>
          </>
        }
      >
        {shown.body ? <p className="confirm-body">{shown.body}</p> : null}
      </Shell>
    </ClosingContext.Provider>
  );
}
