import { Fragment, useEffect, useState } from "react";
import { useStore, type Modal } from "../../state/store";
import { ClipEditorModal } from "./ClipEditor";
import { SettingsModal } from "./SettingsModal";
import { ClosingContext } from "./Shell";
import { AddSongsModal, ListenAlongModal, PlaylistFormModal } from "./SimpleModals";

function render(modal: Modal) {
  switch (modal.type) {
    case "createPlaylist":
      return <PlaylistFormModal addIds={modal.addIds} />;
    case "editPlaylist":
      return <PlaylistFormModal editId={modal.id} />;
    case "addSongs":
      return <AddSongsModal playlistId={modal.playlistId} />;
    case "settings":
      return <SettingsModal initial={modal.tab} />;
    case "listenAlong":
      return <ListenAlongModal />;
    case "clipEditor":
      return <ClipEditorModal trackId={modal.trackId} />;
  }
}

/** Keeps the last modal mounted briefly so it can animate out. */
export function ModalHost() {
  const modal = useStore((s) => s.modal);
  const [shown, setShown] = useState<Modal | null>(modal);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (modal) {
      setShown(modal);
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
  }, [modal, shown]);

  if (!shown) return null;
  return (
    <ClosingContext.Provider value={closing}>
      <Fragment key={JSON.stringify(shown)}>{render(shown)}</Fragment>
    </ClosingContext.Provider>
  );
}
