import type { MouseEvent, ReactNode } from "react";
import { useLongPress } from "../lib/mobile";

/** Recommendation menus stay available to touch and assistive technology without a visible dismiss overlay. */
export function RecommendationCard({ title, className, onMenu, children }: { title: string; className: string; onMenu: (from: MouseEvent | HTMLElement) => void; children: ReactNode }) {
  const longPress = useLongPress(onMenu, ".card-fab, .rec-options, input");
  return (
    <div className={className} onContextMenu={onMenu} {...longPress}>
      {children}
      <button type="button" className="sr-only rec-options" aria-label={`More options for ${title}`} aria-haspopup="menu" onClick={(e) => onMenu(e.currentTarget)}>
        More options
      </button>
    </div>
  );
}
