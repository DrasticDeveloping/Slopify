import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { setState, type Route } from "../state/store";

export interface HeaderInfo {
  title: string;
  tint: string;
  visible: boolean;
  play?: { ids: string[]; label: string; route?: Route };
}

interface HeroProps {
  art: ReactNode;
  kind: string;
  title: string;
  description?: ReactNode;
  meta?: ReactNode;
  tint: string;
  actions?: ReactNode;
  play?: HeaderInfo["play"];
  round?: boolean;
  onTitleClick?: () => void;
}

/**
 * Large collection header. When it scrolls out of view the top bar takes over
 * its title and play button, like a native app's collapsing toolbar.
 */
export function Hero({ art, kind, title, description, meta, tint, actions, play, round, onTitleClick }: HeroProps) {
  const sentinel = useRef<HTMLDivElement>(null);
  const playRef = useRef(play);
  playRef.current = play;

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const root = el.closest(".main-scroll");
    const io = new IntersectionObserver(
      ([entry]) => setState({ header: { title, tint, visible: !entry.isIntersecting, play: playRef.current } }),
      { root, rootMargin: "-64px 0px 0px 0px" },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      setState({ header: null });
    };
  }, [title, tint]);

  // Keep the top bar's play button pointing at the current song list.
  const ids = play?.ids;
  useEffect(() => {
    setState((s) => (s.header && s.header.title === title && s.header.play?.ids !== ids && playRef.current ? { header: { ...s.header, play: playRef.current } } : {}));
  }, [ids, title]);

  const size = title.length > 34 ? "xs" : title.length > 22 ? "sm" : title.length > 12 ? "md" : "lg";

  return (
    <header className="hero" style={{ "--tint": tint } as CSSProperties}>
      <div className={`hero-art${round ? " round" : ""}`}>{art}</div>
      <div className="hero-copy">
        <span className="eyebrow">{kind}</span>
        <h1 className={`hero-title ${size}${onTitleClick ? " editable" : ""}`} onClick={onTitleClick} title={onTitleClick ? "Edit details" : undefined}>
          {title}
        </h1>
        {description ? <p className="hero-desc">{description}</p> : null}
        {meta ? <div className="hero-meta">{meta}</div> : null}
      </div>
      <div ref={sentinel} className="hero-sentinel" aria-hidden="true" />
      {actions ? <div className="hero-actions">{actions}</div> : null}
    </header>
  );
}
