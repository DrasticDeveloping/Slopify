import { useRef } from "react";
import { importFiles } from "../state/actions";
import { Icon } from "./Icon";

/** Files play from this device until the page reloads; the button says so before they're chosen (or `note={false}` when the caller says it nearby). */
export function ChooseFiles({ className = "btn", label = "Choose files", note = true, onChosen }: { className?: string; label?: string; note?: boolean; onChosen?: (ids: string[]) => void }) {
  const file = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={file}
        type="file"
        accept="audio/*,video/*,.flac,.m4a,.opus"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) {
            const ids = importFiles(e.target.files);
            onChosen?.(ids);
          }
          e.target.value = "";
        }}
      />
      <button type="button" className={className} onClick={() => file.current?.click()} title="Files play until you reload. Songs found online can be saved for good.">
        <Icon name="folder" size={18} />
        {label}
        {note ? <> <span className="btn-note">(until you reload)</span></> : null}
      </button>
    </>
  );
}
